import assert from 'node:assert/strict';
import test from 'node:test';
import {
    LEAD_IN_SECONDS,
    RESTART_LEAD_SECONDS,
    chunkTrimSeconds,
    hasLookaheadRoom,
    positionFromContext,
    resolveChunkStart,
    scheduleNextStart,
    seekTargetSample
} from '../src/music/gaplessSchedule.js';

test('scheduleNextStart accounts for seek offset', () => {
    assert.equal(scheduleNextStart(10, 200, 0), 210);
    assert.equal(scheduleNextStart(10, 200, 50), 160);
});

test('positionFromContext', () => {
    assert.equal(positionFromContext(15, 10, 2), 7000);
    assert.equal(positionFromContext(9, 10, 0), 0);
    assert.equal(positionFromContext(9, 10, 3), 3000);
});

test('resolveChunkStart leads in on a fresh clock', () => {
    assert.deepEqual(resolveChunkStart(null, 4), { when: 4 + LEAD_IN_SECONDS, shift: 0, starved: false });
});

test('resolveChunkStart continues exactly at the running clock end', () => {
    assert.deepEqual(resolveChunkStart(12.5, 4), { when: 12.5, shift: 0, starved: false });
});

test('resolveChunkStart restarts slightly ahead and reports the shift when starved', () => {
    const start = resolveChunkStart(10, 11);
    assert.equal(start.starved, true);
    assert.equal(start.when, 11 + RESTART_LEAD_SECONDS);
    assert.ok(Math.abs(start.shift - (1 + RESTART_LEAD_SECONDS)) < 1e-9);
    assert.equal(resolveChunkStart(10.001, 10).starved, true);
});

test('hasLookaheadRoom keeps decoded audio within the look-ahead window', () => {
    assert.equal(hasLookaheadRoom(null, 0), true);
    assert.equal(hasLookaheadRoom(10, 0), true);
    assert.equal(hasLookaheadRoom(10.5, 0), false);
    assert.equal(hasLookaheadRoom(20, 10), true);
});

test('seekTargetSample converts and clamps into the stream', () => {
    assert.equal(seekTargetSample(1000, 44100, 441000), 44100);
    assert.equal(seekTargetSample(-5, 44100, 441000), 0);
    assert.equal(seekTargetSample(99999, 44100, 441000), 440999);
    assert.equal(seekTargetSample(2000, 48000, 0), 96000);
});

test('chunkTrimSeconds is the offset of the target inside its chunk', () => {
    assert.equal(chunkTrimSeconds(66150, 44100, 44100), 0.5);
    assert.equal(chunkTrimSeconds(100, 4096, 44100), 0);
});
