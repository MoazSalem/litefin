import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildTasteProfile,
    createTasteProfileProvider,
    createTasteRowLoader,
    MIN_SUPPORT
} from '../src/utils/TasteRecommendations.js';
import {
    createSerialQueue,
    createBecauseWatchedLoader,
    isRecommendationRowId,
    recommendationRowOffset,
    clampRowCount
} from '../src/utils/BecauseYouWatched.js';

const title = (id, extra = {}) => ({ Id: id, Type: 'Movie', Name: id, People: [], Studios: [], Genres: [], ...extra });
const actor = (id, name) => ({ Id: id, Name: name, Type: 'Actor' });
const director = (id, name) => ({ Id: id, Name: name, Type: 'Director' });

test('buildTasteProfile - ranks sources by recency-weighted coverage', () => {
    const profile = buildTasteProfile([
        title('t1', { People: [actor('a1', 'Ann'), actor('a2', 'Bob')], Genres: ['Drama'] }),
        title('t2', { People: [actor('a1', 'Ann')], Genres: ['Drama', 'Crime'] }),
        title('t3', { People: [actor('a2', 'Bob')], Genres: ['Crime'] })
    ]);
    assert.equal(profile.actor[0].name, 'Ann');
    assert.equal(profile.actor[0].support, 2);
    assert.equal(profile.genre[0].name, 'Drama');
    assert.ok(profile.genre[0].score > profile.genre[1].score);
});

test('buildTasteProfile - a newer title outweighs an older one', () => {
    const profile = buildTasteProfile([
        title('new', { People: [actor('a1', 'Recent')] }),
        title('mid', { People: [actor('a3', 'Other')] }),
        title('old', { People: [actor('a2', 'Old')] })
    ]);
    const names = profile.actor.map((a) => a.name);
    assert.deepEqual(names, ['Recent', 'Other', 'Old']);
});

test('buildTasteProfile - only the top billed actors and directors count', () => {
    const cast = Array.from({ length: 8 }, (_, i) => actor(`a${i}`, `Actor ${i}`));
    const profile = buildTasteProfile([
        title('t1', { People: [...cast, director('d1', 'D1'), director('d2', 'D2'), director('d3', 'D3')] })
    ]);
    assert.equal(profile.actor.length, 5);
    assert.equal(profile.director.length, 2);
});

test('buildTasteProfile - favorites add weight and studios and genre items are read', () => {
    const profile = buildTasteProfile(
        [title('t1', { Studios: [{ Id: 's1', Name: 'Studio One' }] })],
        [title('f1', { Studios: [{ Id: 's1', Name: 'Studio One' }], GenreItems: [{ Id: 'g', Name: 'Sci-Fi' }] })]
    );
    assert.equal(profile.studio[0].support, 2);
    assert.equal(profile.genre[0].name, 'Sci-Fi');
});

test('buildTasteProfile - tolerates empty input', () => {
    const profile = buildTasteProfile(undefined, undefined);
    assert.deepEqual(profile.actor, []);
    assert.deepEqual(profile.genre, []);
});

test('profile provider - restores recency order and excludes watched titles', async () => {
    const exclude = new Set();
    const getProfile = createTasteProfileProvider({
        getPlayed: async () => [
            { Id: 'e1', Type: 'Episode', SeriesId: 's1', SeriesName: 'Show' },
            { Id: 'm1', Type: 'Movie', Name: 'Movie' }
        ],
        // Server returns the older title first.
        getDetails: async () => [
            title('m1', { People: [actor('a2', 'Older')] }),
            title('s1', { Type: 'Series', People: [actor('a1', 'Newer')] })
        ],
        exclude
    });
    const profile = await getProfile();
    assert.equal(profile.actor[0].name, 'Newer');
    assert.ok(exclude.has('s1') && exclude.has('m1'));
});

test('profile provider - survives failures and calls the API once', async () => {
    let calls = 0;
    const errors = [];
    const getProfile = createTasteProfileProvider({
        getPlayed: async () => {
            calls++;
            throw new Error('down');
        },
        getDetails: async () => [],
        onError: (m) => errors.push(m)
    });
    const [a, b] = await Promise.all([getProfile(), getProfile()]);
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    assert.deepEqual(a.actor, []);
    assert.equal(a, b);
});

const richProfile = () => ({
    actor: [
        { id: 'a1', name: 'Ann', score: 3, support: 3 },
        { id: 'a2', name: 'Solo', score: 5, support: MIN_SUPPORT - 1 },
        { id: 'a3', name: 'Bob', score: 2, support: 2 }
    ],
    director: [],
    studio: [],
    genre: []
});

test('row loader - skips one-off sources and sources with too few suggestions', async () => {
    const tried = [];
    const load = createTasteRowLoader({
        getProfile: async () => richProfile(),
        fetchByKind: async (kind, source) => {
            tried.push(source.id);
            return source.id === 'a1' ? [{ Id: 'x' }] : [{ Id: 'p' }, { Id: 'q' }, { Id: 'r' }];
        },
        exclude: new Set()
    });
    const row = await load('actor', 0);
    assert.deepEqual(tried, ['a1', 'a3']);
    assert.equal(row.sourceName, 'Bob');
    assert.equal(row.items.length, 3);
});

test('row loader - returns null for kinds with no candidates', async () => {
    const load = createTasteRowLoader({
        getProfile: async () => richProfile(),
        fetchByKind: async () => [],
        exclude: new Set()
    });
    assert.equal(await load('director', 0), null);
});

test('row loader - rows across kinds and Because You Watched never repeat a title', async () => {
    const exclude = new Set();
    const queue = createSerialQueue();
    const byw = createBecauseWatchedLoader({
        getPlayed: async () => [title('m1')],
        getSimilar: async () => [{ Id: 'x' }, { Id: 'y' }, { Id: 'z' }],
        exclude,
        queue
    });
    const reco = createTasteRowLoader({
        getProfile: async () => richProfile(),
        fetchByKind: async () => [{ Id: 'y' }, { Id: 'z' }, { Id: 'n1' }, { Id: 'n2' }, { Id: 'n3' }],
        exclude,
        queue
    });
    const [taste, because] = await Promise.all([reco('actor', 0), byw(0)]);
    const all = [...taste.items, ...because.items].map((i) => i.Id);
    assert.equal(new Set(all).size, all.length);
});

test('row loader - a failing request moves on to the next candidate', async () => {
    const errors = [];
    const load = createTasteRowLoader({
        getProfile: async () => richProfile(),
        fetchByKind: async (kind, source) => {
            if (source.id === 'a1') throw new Error('boom');
            return [{ Id: '1' }, { Id: '2' }, { Id: '3' }];
        },
        exclude: new Set(),
        onError: (m) => errors.push(m)
    });
    const row = await load('actor', 0);
    assert.equal(row.sourceName, 'Bob');
    assert.equal(errors.length, 1);
});

test('serial queue - runs jobs in order and survives a failing job', async () => {
    const queue = createSerialQueue();
    const order = [];
    const first = queue.run(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
        throw new Error('fail');
    });
    const second = queue.run(async () => order.push(2));
    await assert.rejects(first);
    await second;
    assert.deepEqual(order, [1, 2]);
});

test('row id helpers - recognise recommendation rows and order them', () => {
    assert.equal(isRecommendationRowId('because-watched-2'), true);
    assert.equal(isRecommendationRowId('reco-actor-1'), true);
    assert.equal(isRecommendationRowId('latest-abc'), false);
    assert.ok(recommendationRowOffset('because-watched-1') < recommendationRowOffset('reco-actor-1'));
    assert.ok(recommendationRowOffset('reco-actor') < recommendationRowOffset('reco-genre-1'));
});

test('row loader - claims only the titles it shows so later rows are not starved', async () => {
    const exclude = new Set();
    const pool = Array.from({ length: 10 }, (_, i) => ({ Id: `t${i}` }));
    const load = createTasteRowLoader({
        getProfile: async () => richProfile(),
        fetchByKind: async () => pool,
        exclude,
        rowLimit: 4
    });
    const row = await load('actor', 0);
    assert.equal(row.items.length, 4);
    assert.equal([...exclude].filter((id) => id.startsWith('t')).length, 4);
});

test('row loader - without claiming, a row is the same whichever rows loaded first', async () => {
    const make = () =>
        createTasteRowLoader({
            getProfile: async () => richProfile(),
            fetchByKind: async () => [{ Id: '1' }, { Id: '2' }, { Id: '3' }],
            exclude: new Set(),
            claimTitles: false
        });
    const alone = await make()('actor', 0);
    const loader = make();
    await loader('genre', 0);
    const after = await loader('actor', 0);
    assert.deepEqual(
        after.items.map((i) => i.Id),
        alone.items.map((i) => i.Id)
    );
});

test('profile provider - a failed build is retried by the next call', async () => {
    let calls = 0;
    const getProfile = createTasteProfileProvider({
        getPlayed: async () => {
            calls++;
            if (calls === 1) throw new Error('timeout');
            return [{ Id: 'm1', Type: 'Movie', Name: 'Movie' }];
        },
        getDetails: async () => [title('m1', { People: [actor('a1', 'Ann')] })]
    });
    assert.deepEqual((await getProfile()).actor, []);
    assert.equal((await getProfile()).actor[0].name, 'Ann');
});

test('row count - clamps to 1..3 and defaults to 1', () => {
    assert.equal(clampRowCount(undefined), 1);
    assert.equal(clampRowCount('2'), 2);
    assert.equal(clampRowCount('9'), 3);
    assert.equal(clampRowCount('0'), 1);
    assert.equal(clampRowCount('abc'), 1);
});

test('row ids - every offset stays below the next saved row', () => {
    for (const id of ['because-watched-3', 'reco-actor-3', 'reco-director-3', 'reco-studio-3', 'reco-genre-3']) {
        assert.ok(recommendationRowOffset(id) < 1, id);
    }
    assert.ok(recommendationRowOffset('reco-actor-1') < recommendationRowOffset('reco-actor-2'));
    assert.ok(recommendationRowOffset('because-watched-3') < recommendationRowOffset('reco-actor-1'));
});

test('row loader - rows of one kind use different sources and share no titles, even unclaimed', async () => {
    const load = createTasteRowLoader({
        getProfile: async () => richProfile(),
        fetchByKind: async (kind, source) =>
            source.id === 'a1'
                ? [{ Id: '1' }, { Id: '2' }, { Id: '3' }]
                : [{ Id: '2' }, { Id: '3' }, { Id: '4' }, { Id: '5' }, { Id: '6' }],
        exclude: new Set(),
        claimTitles: false
    });
    const first = await load('actor', 0);
    const second = await load('actor', 1);
    assert.notEqual(first.sourceName, second.sourceName);
    const all = [...first.items, ...second.items].map((i) => i.Id);
    assert.equal(new Set(all).size, all.length);
});
