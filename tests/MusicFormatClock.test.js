import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, progressRatio } from '../src/music/formatClock.js';

test('formatClock renders m:ss and h:mm:ss', () => {
    assert.equal(formatClock(0), '0:00');
    assert.equal(formatClock(5999), '0:05');
    assert.equal(formatClock(65000), '1:05');
    assert.equal(formatClock(3725000), '1:02:05');
});

test('formatClock treats invalid input as zero', () => {
    assert.equal(formatClock(-10), '0:00');
    assert.equal(formatClock(NaN), '0:00');
    assert.equal(formatClock(undefined), '0:00');
});

test('progressRatio is clamped between 0 and 1', () => {
    assert.equal(progressRatio(50, 200), 0.25);
    assert.equal(progressRatio(300, 200), 1);
    assert.equal(progressRatio(10, 0), 0);
    assert.equal(progressRatio(-5, 100), 0);
});
