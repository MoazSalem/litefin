import assert from 'node:assert/strict';
import test from 'node:test';
import {
    LAYOUT,
    chooseLayout,
    lineState,
    changedLineStates,
    lyricsScrollOffset,
    nextRepeatMode,
    washBackground
} from '../src/music/nowPlayingView.js';

const synced = { synced: true, lines: [{ startMs: 0, text: 'a' }] };
const unsynced = { synced: false, lines: [{ startMs: null, text: 'a' }] };

test('chooseLayout picks lyrics for synced lyrics with the toggle on', () => {
    assert.equal(chooseLayout(synced, true), LAYOUT.LYRICS);
});

test('chooseLayout picks static-lyrics for unsynced lyrics with the toggle on', () => {
    assert.equal(chooseLayout(unsynced, true), LAYOUT.STATIC_LYRICS);
});

test('chooseLayout picks ambient when the toggle is off or there are no lyrics', () => {
    assert.equal(chooseLayout(synced, false), LAYOUT.AMBIENT);
    assert.equal(chooseLayout(unsynced, false), LAYOUT.AMBIENT);
    assert.equal(chooseLayout(null, true), LAYOUT.AMBIENT);
});

test('lineState marks the active line now, earlier past, later next', () => {
    assert.equal(lineState(2, 2), 'now');
    assert.equal(lineState(1, 2), 'past');
    assert.equal(lineState(3, 2), 'next');
    assert.equal(lineState(0, -1), 'next');
});

test('changedLineStates moving forward one line touches only two lines', () => {
    assert.deepEqual(changedLineStates(2, 3), [
        { index: 2, state: 'past' },
        { index: 3, state: 'now' }
    ]);
});

test('changedLineStates from nothing active marks the skipped lines past', () => {
    assert.deepEqual(changedLineStates(-1, 2), [
        { index: 0, state: 'past' },
        { index: 1, state: 'past' },
        { index: 2, state: 'now' }
    ]);
});

test('changedLineStates seeking backwards restores lines to next', () => {
    assert.deepEqual(changedLineStates(3, 1), [
        { index: 1, state: 'now' },
        { index: 2, state: 'next' },
        { index: 3, state: 'next' }
    ]);
});

test('changedLineStates back to before the first line clears the old active', () => {
    assert.deepEqual(changedLineStates(1, -1), [
        { index: 0, state: 'next' },
        { index: 1, state: 'next' }
    ]);
});

test('changedLineStates with no change is empty', () => {
    assert.deepEqual(changedLineStates(4, 4), []);
    assert.deepEqual(changedLineStates(-1, -1), []);
});

test('lyricsScrollOffset keeps the line in the upper third and never scrolls above the top', () => {
    assert.equal(lyricsScrollOffset(500, 600), 308);
    assert.equal(lyricsScrollOffset(100, 600), 0);
    assert.equal(lyricsScrollOffset(-1, 600), 0);
});

test('nextRepeatMode cycles none, all, one', () => {
    assert.equal(nextRepeatMode('RepeatNone'), 'RepeatAll');
    assert.equal(nextRepeatMode('RepeatAll'), 'RepeatOne');
    assert.equal(nextRepeatMode('RepeatOne'), 'RepeatNone');
    assert.equal(nextRepeatMode(undefined), 'RepeatAll');
});

test('washBackground builds three soft radial gradients from the palette', () => {
    const css = washBackground([
        [10, 20, 30],
        [40, 50, 60],
        [70, 80, 90]
    ]);
    assert.equal((css.match(/radial-gradient\(/g) || []).length, 3);
    assert.match(css, /rgba\(10, 20, 30, 0\.\d+\)/);
    assert.match(css, /rgba\(40, 50, 60, 0\.\d+\)/);
    assert.match(css, /rgba\(70, 80, 90, 0\.\d+\)/);
});
