import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRoute, isMusicItem, isMusicPlayRequest } from '../src/music/musicSection.js';

test('classifyRoute', () => {
    assert.equal(classifyRoute('/now-playing'), 'music');
    assert.equal(classifyRoute('/details/abc'), 'pending');
    assert.equal(classifyRoute('/library/xyz/genre/1'), 'pending');
    assert.equal(classifyRoute('/home'), 'outside');
    assert.equal(classifyRoute('/player/abc/0'), 'outside');
    assert.equal(classifyRoute('/settings'), 'outside');
});

test('isMusicItem accepts music types and rejects audiobooks and playlists', () => {
    assert.equal(isMusicItem({ Type: 'MusicAlbum' }), true);
    assert.equal(isMusicItem({ Type: 'Audio' }), true);
    assert.equal(isMusicItem({ Type: 'MusicArtist' }), true);
    assert.equal(isMusicItem({ Type: 'MusicGenre' }), true);
    assert.equal(isMusicItem({ Type: 'AudioBook' }), false);
    assert.equal(isMusicItem({ Type: 'Playlist' }), false);
    assert.equal(isMusicItem({ Type: 'Movie' }), false);
});

test('isMusicPlayRequest excludes audiobooks and video', () => {
    assert.equal(isMusicPlayRequest({ Type: 'Audio' }), true);
    assert.equal(isMusicPlayRequest({ Type: 'MusicAlbum' }), true);
    assert.equal(isMusicPlayRequest({ Type: 'MusicArtist' }), true);
    assert.equal(isMusicPlayRequest({ Type: 'MusicGenre' }), true);
    assert.equal(isMusicPlayRequest({ Type: 'AudioBook' }), false);
    assert.equal(isMusicPlayRequest({ Type: 'Movie', MediaType: 'Video' }), false);
});
