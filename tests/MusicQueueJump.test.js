import assert from 'node:assert/strict';
import test from 'node:test';

const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.document = {
    createElement: () => ({ canPlayType: () => '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { setAttribute: () => {}, style: {} },
    body: { appendChild: () => {}, style: {} }
};
globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: globalThis.localStorage
};
globalThis.__APP_VERSION__ = '1.0.0';

const { playQueue } = await import('../src/core/PlayQueue.js');
const { playFromQueueCursor } = await import('../src/music/queueJump.js');

const tracks = () => Array.from({ length: 8 }, (_, i) => ({ Id: `t${i}`, Name: `Track ${i}`, Type: 'Audio' }));

function recordingSession() {
    const calls = [];
    return { calls, playItems: (items, index) => calls.push({ items, index }) };
}

test('queue jump with shuffle on plays the track the user picked', () => {
    playQueue.setShuffleMode(false);
    playQueue.setQueue(tracks(), 0);
    playQueue.setShuffleMode(true);
    const snapshot = playQueue.getQueue().slice();
    const picked = snapshot[5];

    playQueue.setQueue(snapshot, 5);
    const session = recordingSession();
    playFromQueueCursor(playQueue, session);

    const { items, index } = session.calls[0];
    assert.equal(items[index].Id, picked.Id);
    playQueue.setShuffleMode(false);
});

test('queue jump without shuffle plays the picked index', () => {
    playQueue.setShuffleMode(false);
    playQueue.setQueue(tracks(), 0);
    playQueue.setQueue(playQueue.getQueue().slice(), 3);
    const session = recordingSession();
    playFromQueueCursor(playQueue, session);
    assert.equal(session.calls[0].index, 3);
    assert.equal(session.calls[0].items[3].Id, 't3');
});

test('queue jump passes a copy so the session can replace the queue safely', () => {
    playQueue.setQueue(tracks(), 2);
    const session = recordingSession();
    playFromQueueCursor(playQueue, session);
    assert.notEqual(session.calls[0].items, playQueue.getQueue());
});
