import assert from 'node:assert/strict';
import test from 'node:test';
import { createLyricsStore } from '../src/music/lyricsStore.js';

const SYNCED_DTO = { Lyrics: [{ Text: 'hello', Start: 10_000_000 }] };

function setup(responses = {}) {
    const calls = [];
    const fetchLyrics = async (id) => {
        calls.push(id);
        const response = responses[id];
        if (response instanceof Error) throw response;
        return response;
    };
    return { calls, store: createLyricsStore({ fetchLyrics, limit: 2 }) };
}

test('load parses lyrics and peek returns them once settled', async () => {
    const { store } = setup({ a: SYNCED_DTO });
    assert.equal(store.peek('a'), undefined);
    const lyrics = await store.load({ Id: 'a' });
    assert.deepEqual(lyrics, { synced: true, lines: [{ startMs: 1000, text: 'hello' }] });
    assert.deepEqual(store.peek('a'), { lyrics });
});

test('load fetches each item once', async () => {
    const { store, calls } = setup({ a: SYNCED_DTO });
    await Promise.all([store.load({ Id: 'a' }), store.load({ Id: 'a' })]);
    await store.load({ Id: 'a' });
    assert.deepEqual(calls, ['a']);
});

test('items flagged without lyrics are not fetched', async () => {
    const { store, calls } = setup();
    assert.equal(await store.load({ Id: 'a', HasLyrics: false }), null);
    assert.deepEqual(store.peek('a'), { lyrics: null });
    assert.deepEqual(calls, []);
});

test('lyrics with only blank lines count as none', async () => {
    const { store } = setup({ a: { Lyrics: [{ Text: ' ' }, { Text: '' }] } });
    assert.equal(await store.load({ Id: 'a' }), null);
});

test('a failed fetch resolves null and is retried next time', async () => {
    const { store, calls } = setup({ a: new Error('404') });
    assert.equal(await store.load({ Id: 'a' }), null);
    assert.equal(store.peek('a'), undefined);
    await store.load({ Id: 'a' });
    assert.deepEqual(calls, ['a', 'a']);
});

test('the oldest entry is evicted past the limit', async () => {
    const { store, calls } = setup({ a: SYNCED_DTO, b: SYNCED_DTO, c: SYNCED_DTO });
    await store.load({ Id: 'a' });
    await store.load({ Id: 'b' });
    await store.load({ Id: 'a' });
    await store.load({ Id: 'c' });
    assert.equal(store.peek('b'), undefined);
    assert.ok(store.peek('a'));
    assert.deepEqual(calls, ['a', 'b', 'c']);
});

test('load without an item resolves null', async () => {
    const { store } = setup();
    assert.equal(await store.load(null), null);
});
