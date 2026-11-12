import assert from 'node:assert/strict';
import test from 'node:test';
import {
    addTrack,
    closeTrack,
    dropFrom,
    emptyTimeline,
    entryAt,
    evictionEnd,
    positionMs
} from '../src/music/mseTimeline.js';

const frozenTimeline = (...entries) => Object.freeze({ entries: Object.freeze(entries.map((e) => Object.freeze(e))) });

test('emptyTimeline has no entries', () => {
    assert.deepEqual(emptyTimeline(), { entries: [] });
});

test('mid-track load: origin = mediaTimeAtFirstAppend - segmentStart', () => {
    const segmentStart = 60;
    const origin = 0 - segmentStart;
    const timeline = addTrack(emptyTimeline(), 'a', origin);
    assert.equal(origin, -60);
    assert.equal(positionMs(timeline, 1.0), 61000);
});

test('normal load with timestampOffset at segment start: origin 0, media time equals track time', () => {
    const timeline = addTrack(emptyTimeline(), 'a', 0);
    assert.equal(positionMs(timeline, 12.5), 12500);
});

test('entryAt returns the new track exactly at a boundary', () => {
    const timeline = addTrack(closeTrack(addTrack(emptyTimeline(), 'a', 0), 'a', 10), 'b', 10);
    assert.equal(entryAt(timeline, 9.999).trackId, 'a');
    assert.equal(entryAt(timeline, 10).trackId, 'b');
    assert.equal(entryAt(timeline, 25).trackId, 'b');
});

test('entryAt is null with no entries or before the first origin', () => {
    assert.equal(entryAt(emptyTimeline(), 1), null);
    assert.equal(entryAt(addTrack(emptyTimeline(), 'a', 5), 4.9), null);
});

test('positionMs is 0 when no entry matches', () => {
    assert.equal(positionMs(emptyTimeline(), 3), 0);
    assert.equal(positionMs(addTrack(emptyTimeline(), 'a', 5), 4), 0);
});

test('addTrack appends an open entry', () => {
    assert.deepEqual(addTrack(emptyTimeline(), 'a', 2).entries, [{ trackId: 'a', origin: 2, end: null }]);
});

test('closeTrack sets end on that entry only', () => {
    const timeline = frozenTimeline({ trackId: 'a', origin: 0, end: null }, { trackId: 'b', origin: 10, end: null });
    assert.deepEqual(closeTrack(timeline, 'a', 10).entries, [
        { trackId: 'a', origin: 0, end: 10 },
        { trackId: 'b', origin: 10, end: null }
    ]);
});

test('closeTrack and dropFrom return the timeline unchanged for an unknown trackId', () => {
    const timeline = frozenTimeline({ trackId: 'a', origin: 0, end: null });
    assert.deepEqual(closeTrack(timeline, 'x', 5), timeline);
    assert.deepEqual(dropFrom(timeline, 'x'), timeline);
});

test('dropFrom the second of three entries leaves one', () => {
    const timeline = frozenTimeline(
        { trackId: 'a', origin: 0, end: 10 },
        { trackId: 'b', origin: 10, end: 20 },
        { trackId: 'c', origin: 20, end: null }
    );
    assert.deepEqual(dropFrom(timeline, 'b').entries, [{ trackId: 'a', origin: 0, end: 10 }]);
});

test('inputs are never mutated', () => {
    const timeline = frozenTimeline({ trackId: 'a', origin: 0, end: null });
    assert.doesNotThrow(() => {
        addTrack(timeline, 'b', 10);
        closeTrack(timeline, 'a', 10);
        dropFrom(timeline, 'a');
    });
    assert.deepEqual(timeline.entries, [{ trackId: 'a', origin: 0, end: null }]);
});

test('evictionEnd keeps 4 s behind by default and never goes negative', () => {
    assert.equal(evictionEnd(10), 6);
    assert.equal(evictionEnd(2), 0);
    assert.equal(evictionEnd(10, 1), 9);
});
