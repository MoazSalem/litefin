import { test } from 'node:test';
import assert from 'node:assert/strict';
import SourceBufferQueue from '../src/music/sourceBufferQueue.js';

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

function fakeSourceBuffer() {
    const listeners = new Map();
    const sb = {
        updating: false,
        log: [],
        addEventListener(event, handler) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(handler);
        },
        removeEventListener(event, handler) {
            listeners.get(event)?.delete(handler);
        },
        fire(event) {
            [...(listeners.get(event) || [])].forEach((handler) => handler());
        },
        start(name, { fail = false } = {}) {
            if (sb.updating) throw new DOMException('busy', 'InvalidStateError');
            sb.log.push(`start:${name}`);
            sb.updating = true;
            setImmediate(() => {
                sb.updating = false;
                sb.log.push(`end:${name}`);
                if (fail) sb.fire('error');
                setImmediate(() => sb.fire('updateend'));
            });
        }
    };
    return sb;
}

test('operations run one at a time, each waiting for its own updateend', async () => {
    const sb = fakeSourceBuffer();
    const queue = new SourceBufferQueue(sb);
    await Promise.all([queue.run((b) => b.start('a')), queue.run((b) => b.start('b')), queue.run((b) => b.start('c'))]);
    assert.deepEqual(sb.log, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('a synchronous operation resolves without waiting for an event', async () => {
    const sb = fakeSourceBuffer();
    const queue = new SourceBufferQueue(sb);
    let set = null;
    await queue.run(() => {
        set = 5;
    });
    assert.equal(set, 5);
});

test('an update error rejects only after its updateend, and the next operation still runs', async () => {
    const sb = fakeSourceBuffer();
    const queue = new SourceBufferQueue(sb);
    const failing = queue.run((b) => b.start('bad', { fail: true }));
    const next = queue.run((b) => b.start('good'));
    await assert.rejects(failing, /update failed/);
    await next;
    assert.deepEqual(sb.log, ['start:bad', 'end:bad', 'start:good', 'end:good']);
});

test('a thrown operation rejects without blocking the chain', async () => {
    const sb = fakeSourceBuffer();
    const queue = new SourceBufferQueue(sb);
    const quota = queue.run(() => {
        throw new DOMException('full', 'QuotaExceededError');
    });
    await assert.rejects(quota, (err) => err.name === 'QuotaExceededError');
    await queue.run((b) => b.start('after'));
    assert.deepEqual(sb.log, ['start:after', 'end:after']);
});

test('dispose rejects the pending and later operations', async () => {
    const sb = fakeSourceBuffer();
    const queue = new SourceBufferQueue(sb);
    const pending = queue.run((b) => {
        b.updating = true;
    });
    const queued = queue.run((b) => b.start('never'));
    await nextTask();
    queue.dispose();
    await assert.rejects(pending, /disposed/);
    await assert.rejects(queued, /disposed/);
    assert.deepEqual(sb.log, []);
});
