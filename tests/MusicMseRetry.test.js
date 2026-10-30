import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRetry, retryDue } from '../src/music/mseRetry.js';

const first = (ahead) => nextRetry(null, { now: 1000, ahead, refetched: false });

test('a first failure retries only with more than 3 s buffered ahead', () => {
    assert.equal(first(3), null);
    assert.deepEqual(first(3.1), { startedAt: 1000, attempt: 1, at: 1500, refetchPlaylist: true });
});

test('the delay doubles from 0.5 s and is capped at 4 s', () => {
    let retry = first(10);
    const delays = [];
    for (let i = 0; i < 6; i++) {
        const now = retry.at;
        retry = nextRetry(retry, { now, ahead: 10, refetched: false });
        delays.push(retry.at - now);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 4000, 4000, 4000]);
});

test('the playlist is refetched until one refetch succeeded', () => {
    const retry = first(10);
    assert.equal(nextRetry(retry, { now: 1500, ahead: 10, refetched: false }).refetchPlaylist, true);
    const refetched = nextRetry(retry, { now: 1500, ahead: 10, refetched: true });
    assert.equal(refetched.refetchPlaylist, false);
    assert.equal(nextRetry(refetched, { now: 2500, ahead: 10, refetched: false }).refetchPlaylist, false);
});

test('retrying stops once the buffer ahead is below 1 s or after 30 s', () => {
    const retry = first(10);
    assert.ok(nextRetry(retry, { now: 1500, ahead: 1, refetched: false }));
    assert.equal(nextRetry(retry, { now: 1500, ahead: 0.9, refetched: false }), null);
    assert.ok(nextRetry(retry, { now: 30999, ahead: 10, refetched: false }));
    assert.equal(nextRetry(retry, { now: 31000, ahead: 10, refetched: false }), null);
});

test('an attempt is due without a retry, at its time, or early when the buffer drains', () => {
    const retry = first(10);
    assert.equal(retryDue(null, { now: 0, ahead: 0 }), true);
    assert.equal(retryDue(retry, { now: 1499, ahead: 5 }), false);
    assert.equal(retryDue(retry, { now: 1500, ahead: 5 }), true);
    assert.equal(retryDue(retry, { now: 1000, ahead: 0.5 }), true);
});
