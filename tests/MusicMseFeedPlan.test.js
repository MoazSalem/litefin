import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEED_STEP, NEXT_STATE, nextFeedStep, nextState } from '../src/music/mseFeedPlan.js';

const head = (index, count) => ({ index, playlist: { segments: Array.from({ length: count }, () => ({})) } });

test('a head item with segments left appends until the buffer is full', () => {
    assert.equal(nextFeedStep({ head: head(1, 3), bufferFull: false, next: NEXT_STATE.NONE }), FEED_STEP.APPEND);
    assert.equal(nextFeedStep({ head: head(1, 3), bufferFull: true, next: NEXT_STATE.PENDING }), FEED_STEP.WAIT);
});

test('a head item with every segment appended is closed', () => {
    assert.equal(nextFeedStep({ head: head(3, 3), bufferFull: true, next: NEXT_STATE.NONE }), FEED_STEP.CLOSE);
});

test('with nothing left to append the next track decides between starting it, waiting and ending', () => {
    const step = (next) => nextFeedStep({ head: undefined, bufferFull: false, next });
    assert.equal(step(NEXT_STATE.PENDING), FEED_STEP.START_NEXT);
    assert.equal(step(NEXT_STATE.STARTED), FEED_STEP.WAIT);
    assert.equal(step(NEXT_STATE.NONE), FEED_STEP.END);
    assert.equal(step(NEXT_STATE.BLOCKED), FEED_STEP.END);
});

test('nextState describes the known next track', () => {
    const track = { id: 'b' };
    assert.equal(nextState({ track: null, key: null, blocked: false }), NEXT_STATE.NONE);
    assert.equal(nextState({ track, key: null, blocked: false }), NEXT_STATE.PENDING);
    assert.equal(nextState({ track, key: 'b#2', blocked: false }), NEXT_STATE.STARTED);
    assert.equal(nextState({ track, key: null, blocked: true }), NEXT_STATE.BLOCKED);
});
