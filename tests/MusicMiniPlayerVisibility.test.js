import assert from 'node:assert/strict';
import test from 'node:test';
import { miniPlayerVisible } from '../src/music/miniPlayerVisibility.js';

test('hidden when music is not active', () => {
    assert.equal(miniPlayerVisible({ active: false, path: '/details/abc' }), false);
});

test('visible on music section pages while active', () => {
    assert.equal(miniPlayerVisible({ active: true, path: '/details/abc' }), true);
    assert.equal(miniPlayerVisible({ active: true, path: '/library/xyz/genre/1' }), true);
});

test('hidden on the now-playing screen', () => {
    assert.equal(miniPlayerVisible({ active: true, path: '/now-playing' }), false);
});

test('hidden outside the music section', () => {
    assert.equal(miniPlayerVisible({ active: true, path: '/home' }), false);
    assert.equal(miniPlayerVisible({ active: true, path: '/settings' }), false);
    assert.equal(miniPlayerVisible({ active: true, path: '/player/abc/0' }), false);
});

test('ignores the query string', () => {
    assert.equal(miniPlayerVisible({ active: true, path: '/details/abc?x=1' }), true);
    assert.equal(miniPlayerVisible({ active: true, path: '/now-playing?x=1' }), false);
});
