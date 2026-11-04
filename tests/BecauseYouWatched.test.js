import assert from 'node:assert/strict';
import test from 'node:test';
import { pickSources, filterSimilar, createBecauseWatchedLoader } from '../src/utils/BecauseYouWatched.js';

const episode = (id, seriesId, seriesName) => ({ Id: id, Type: 'Episode', SeriesId: seriesId, SeriesName: seriesName });
const movie = (id, name) => ({ Id: id, Type: 'Movie', Name: name });

test('pickSources - collapses episodes to their series and keeps order', () => {
    const sources = pickSources([
        episode('e1', 's1', 'Show A'),
        episode('e2', 's1', 'Show A'),
        movie('m1', 'Movie One'),
        episode('e3', 's2', 'Show B')
    ]);
    assert.deepEqual(sources, [
        { id: 's1', name: 'Show A' },
        { id: 'm1', name: 'Movie One' },
        { id: 's2', name: 'Show B' }
    ]);
});

test('pickSources - ignores empty and nameless entries', () => {
    assert.deepEqual(pickSources([null, { Id: 'x' }, movie('m1', 'Ok')]), [{ id: 'm1', name: 'Ok' }]);
    assert.deepEqual(pickSources(undefined), []);
});

test('filterSimilar - drops excluded and already watched items', () => {
    const items = [
        { Id: 'a' },
        { Id: 'b', UserData: { Played: true } },
        { Id: 'c', UserData: { Played: false } },
        { Id: 'd' }
    ];
    const result = filterSimilar(items, new Set(['d']));
    assert.deepEqual(
        result.map((i) => i.Id),
        ['a', 'c']
    );
});

test('loader - rows use different sources and never repeat a suggestion', async () => {
    const similarBySource = {
        s1: [{ Id: 'x' }, { Id: 'y' }],
        m1: [{ Id: 'y' }, { Id: 'z' }]
    };
    const load = createBecauseWatchedLoader({
        getPlayed: async () => [episode('e1', 's1', 'Show A'), movie('m1', 'Movie One')],
        getSimilar: async (id) => similarBySource[id]
    });
    // Request out of order: results must still be assigned in order.
    const [second, first] = await Promise.all([load(1), load(0)]);
    assert.equal(first.sourceName, 'Show A');
    assert.deepEqual(
        first.items.map((i) => i.Id),
        ['x', 'y']
    );
    assert.equal(second.sourceName, 'Movie One');
    assert.deepEqual(
        second.items.map((i) => i.Id),
        ['z']
    );
});

test('loader - skips sources with no usable suggestions or failing requests', async () => {
    const errors = [];
    const load = createBecauseWatchedLoader({
        getPlayed: async () => [movie('m1', 'Empty'), movie('m2', 'Broken'), movie('m3', 'Good')],
        getSimilar: async (id) => {
            if (id === 'm1') return [];
            if (id === 'm2') throw new Error('boom');
            return [{ Id: 'r1' }];
        },
        onError: (msg) => errors.push(msg)
    });
    const row = await load(0);
    assert.equal(row.sourceName, 'Good');
    assert.equal(errors.length, 1);
    assert.equal(await load(1), null);
});

test('loader - does not suggest a title the user recently watched', async () => {
    const load = createBecauseWatchedLoader({
        getPlayed: async () => [movie('m1', 'One'), movie('m2', 'Two')],
        getSimilar: async () => [{ Id: 'm2' }, { Id: 'n1' }]
    });
    const row = await load(0);
    assert.deepEqual(
        row.items.map((i) => i.Id),
        ['n1']
    );
});

test('loader - survives a failing recently played request', async () => {
    const load = createBecauseWatchedLoader({
        getPlayed: async () => {
            throw new Error('down');
        },
        getSimilar: async () => []
    });
    assert.equal(await load(0), null);
});
