import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMusicQueue, ALBUM_TRACK_SORT, COLLECTION_TRACK_SORT } from '../src/music/resolveMusicQueue.js';

const songs = (ids) => ids.map((id) => ({ Id: id, Type: 'Audio', Name: id }));

function makeGetItems(responses) {
    const calls = [];
    const getItems = async (params) => {
        calls.push(params);
        const key = Object.keys(responses).find((k) => params[k] !== undefined);
        const value = key ? responses[key] : [];
        if (value instanceof Error) throw value;
        return { Items: value };
    };
    return { getItems, calls };
}

test('album container queues all its tracks sorted by disc and track, from the first', async () => {
    const { getItems, calls } = makeGetItems({ AlbumIds: songs(['t1', 't2', 't3']) });
    const result = await resolveMusicQueue({ item: { Id: 'alb', Type: 'MusicAlbum' } }, { getItems });
    assert.deepEqual(
        result.tracks.map((t) => t.Id),
        ['t1', 't2', 't3']
    );
    assert.equal(result.startIndex, 0);
    assert.equal(calls[0].AlbumIds, 'alb');
    assert.equal(calls[0].IncludeItemTypes, 'Audio');
    assert.equal(calls[0].SortBy, ALBUM_TRACK_SORT);
    assert.equal(ALBUM_TRACK_SORT, 'ParentIndexNumber,IndexNumber,SortName');
    assert.equal(calls[0].SortOrder, 'Ascending');
    assert.equal(calls[0].Recursive, true);
});

test('album container falls back to ParentId when AlbumIds is empty', async () => {
    const { getItems, calls } = makeGetItems({ AlbumIds: [], ParentId: songs(['p1']) });
    const result = await resolveMusicQueue({ item: { Id: 'alb', Type: 'MusicAlbum' } }, { getItems });
    assert.deepEqual(
        result.tracks.map((t) => t.Id),
        ['p1']
    );
    assert.equal(calls[1].ParentId, 'alb');
});

test('artist and genre containers query by their ids and group by album', async () => {
    const artist = makeGetItems({ ArtistIds: songs(['a1', 'a2']) });
    const byArtist = await resolveMusicQueue(
        { item: { Id: 'art', Type: 'MusicArtist' } },
        { getItems: artist.getItems }
    );
    assert.equal(byArtist.tracks.length, 2);
    assert.equal(artist.calls[0].ArtistIds, 'art');
    assert.equal(artist.calls[0].SortBy, COLLECTION_TRACK_SORT);

    const genre = makeGetItems({ GenreIds: songs(['g1']) });
    const byGenre = await resolveMusicQueue({ item: { Id: 'gen', Type: 'MusicGenre' } }, { getItems: genre.getItems });
    assert.equal(byGenre.tracks.length, 1);
    assert.equal(genre.calls[0].GenreIds, 'gen');
});

test('empty container resolves to no tracks', async () => {
    const { getItems } = makeGetItems({});
    const result = await resolveMusicQueue({ item: { Id: 'alb', Type: 'MusicAlbum' } }, { getItems });
    assert.deepEqual(result, { tracks: [], startIndex: 0 });
});

test('container lookup failures propagate', async () => {
    const { getItems } = makeGetItems({ AlbumIds: new Error('offline') });
    await assert.rejects(resolveMusicQueue({ item: { Id: 'alb', Type: 'MusicAlbum' } }, { getItems }), /offline/);
});

test('shuffled container starts at a random track', async () => {
    const { getItems } = makeGetItems({ AlbumIds: songs(['t1', 't2', 't3', 't4']) });
    const result = await resolveMusicQueue(
        { item: { Id: 'alb', Type: 'MusicAlbum' }, shuffle: true },
        { getItems, random: () => 0.6 }
    );
    assert.equal(result.startIndex, 2);
});

test('song with music context queues that album starting at the song', async () => {
    const { getItems, calls } = makeGetItems({ AlbumIds: songs(['t1', 't2', 't3']) });
    const result = await resolveMusicQueue(
        { item: { Id: 't2', Type: 'Audio', AlbumId: 'other' }, contextType: 'music', contextId: 'alb' },
        { getItems }
    );
    assert.equal(calls[0].AlbumIds, 'alb');
    assert.equal(result.startIndex, 1);
    assert.equal(result.tracks.length, 3);
});

test('song context can also come from the item itself', async () => {
    const { getItems, calls } = makeGetItems({ AlbumIds: songs(['t1', 't2']) });
    await resolveMusicQueue(
        { item: { Id: 't2', Type: 'Audio', contextType: 'music', contextId: 'alb' } },
        { getItems }
    );
    assert.equal(calls[0].AlbumIds, 'alb');
});

test('shuffle on a song still starts at that song', async () => {
    const { getItems } = makeGetItems({ AlbumIds: songs(['t1', 't2', 't3']) });
    const result = await resolveMusicQueue(
        { item: { Id: 't3', Type: 'Audio' }, contextType: 'music', contextId: 'alb', shuffle: true },
        { getItems, random: () => 0 }
    );
    assert.equal(result.startIndex, 2);
});

test('song without context queues its own album starting at the song', async () => {
    const { getItems, calls } = makeGetItems({ AlbumIds: songs(['t1', 't2']) });
    const result = await resolveMusicQueue({ item: { Id: 't2', Type: 'Audio', AlbumId: 'alb2' } }, { getItems });
    assert.equal(calls[0].AlbumIds, 'alb2');
    assert.equal(result.startIndex, 1);
});

test('song without an album plays alone', async () => {
    const { getItems, calls } = makeGetItems({});
    const item = { Id: 's', Type: 'Audio' };
    const result = await resolveMusicQueue({ item }, { getItems });
    assert.deepEqual(result, { tracks: [item], startIndex: 0 });
    assert.equal(calls.length, 0);
});

test('song missing from its album, or album lookup failing, plays alone', async () => {
    const item = { Id: 'x', Type: 'Audio', AlbumId: 'alb' };
    const missing = makeGetItems({ AlbumIds: songs(['t1', 't2']) });
    assert.deepEqual(await resolveMusicQueue({ item }, { getItems: missing.getItems }), {
        tracks: [item],
        startIndex: 0
    });
    const failing = makeGetItems({ AlbumIds: new Error('offline') });
    assert.deepEqual(await resolveMusicQueue({ item }, { getItems: failing.getItems }), {
        tracks: [item],
        startIndex: 0
    });
});

test('non-music context on a song falls back to its album', async () => {
    const { getItems, calls } = makeGetItems({ AlbumIds: songs(['t1']) });
    await resolveMusicQueue(
        { item: { Id: 't1', Type: 'Audio', AlbumId: 'alb' }, contextType: 'playlist', contextId: 'pl' },
        { getItems }
    );
    assert.equal(calls[0].AlbumIds, 'alb');
});
