import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    SEERR_DOWNLOAD_POLL_ACTIVE_MS,
    SEERR_DOWNLOAD_POLL_IDLE_MS,
    SEERR_STATUS,
    describeSeerrDownloadBadge,
    extractSeerrDownloads,
    normalizeSeerrItem,
    seerrDownloadPollDelay,
    splitSeerrEta
} from '../src/api/seerrNormalize.js';
import SeerrDownloadPoller from '../src/utils/SeerrDownloadPoller.js';

/**
 * ============================================================================
 * Unit Tests: Seerr Download Status, Progress and ETA
 * ============================================================================
 * Verifies that:
 *   - Seerr's downloadStatus / downloadStatus4k are normalized like Seerr's UI
 *   - poll cadence and the download badge follow Seerr's own badge
 *   - the download poller keeps its cadence, pauses and drops stale responses
 *   - a progress refresh can never move focus or drop focus-restoring caches
 * ============================================================================
 */

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const inMinutes = (minutes) => new Date(NOW + minutes * 60000).toISOString();

test('absent, empty or malformed download data yields no downloads', () => {
    assert.deepEqual(extractSeerrDownloads(null, NOW), []);
    assert.deepEqual(extractSeerrDownloads({}, NOW), []);
    assert.deepEqual(extractSeerrDownloads({ downloadStatus: [], downloadStatus4k: [] }, NOW), []);
    assert.deepEqual(extractSeerrDownloads({ downloadStatus: 'nope', downloadStatus4k: {} }, NOW), []);
    assert.deepEqual(extractSeerrDownloads({ downloadStatus: [null, 'x', 7] }, NOW), []);
});

test('a movie download carries percent, status, title and ETA', () => {
    const downloads = extractSeerrDownloads(
        {
            downloadStatus: [
                {
                    title: 'Movie.2024.1080p.WEB',
                    size: 1000,
                    sizeLeft: 580,
                    status: 'downloading',
                    estimatedCompletionTime: inMinutes(18),
                    downloadId: 'abc'
                }
            ]
        },
        NOW
    );
    assert.deepEqual(downloads, [
        {
            title: 'Movie.2024.1080p.WEB',
            percent: 42,
            status: 'downloading',
            etaMs: 18 * 60000,
            is4k: false,
            season: null,
            episode: null,
            isSeasonPack: false
        }
    ]);
});

test('separate episode downloads stay separate, a shared downloadId collapses into one season pack', () => {
    const episode = (episodeNumber, downloadId) => ({
        size: 100,
        sizeLeft: 50,
        downloadId,
        episode: { seasonNumber: 2, episodeNumber }
    });

    const separate = extractSeerrDownloads({ downloadStatus: [episode(1, 'a'), episode(2, 'b')] }, NOW);
    assert.equal(separate.length, 2);
    assert.deepEqual(
        separate.map((d) => [d.season, d.episode, d.isSeasonPack]),
        [
            [2, 1, false],
            [2, 2, false]
        ]
    );

    const pack = extractSeerrDownloads({ downloadStatus: [episode(1, 'p'), episode(2, 'p'), episode(3, 'p')] }, NOW);
    assert.equal(pack.length, 1);
    assert.equal(pack[0].isSeasonPack, true);
    assert.equal(pack[0].season, 2);
    assert.equal(pack[0].episode, null);

    // Without a downloadId the entries cannot be proven to be one pack
    assert.equal(extractSeerrDownloads({ downloadStatus: [episode(1, ''), episode(2, '')] }, NOW).length, 2);
});

test('4K downloads are flagged and listed after the regular ones', () => {
    const downloads = extractSeerrDownloads(
        {
            downloadStatus: [{ size: 10, sizeLeft: 5, downloadId: 'hd' }],
            downloadStatus4k: [{ size: 10, sizeLeft: 9, downloadId: 'uhd' }]
        },
        NOW
    );
    assert.deepEqual(
        downloads.map((d) => [d.is4k, d.percent]),
        [
            [false, 50],
            [true, 10]
        ]
    );
});

test('percent is clamped and reads 0 when the size is unknown', () => {
    const percentOf = (raw) => extractSeerrDownloads({ downloadStatus: [raw] }, NOW)[0].percent;
    assert.equal(percentOf({ size: 0, sizeLeft: 0 }), 0);
    assert.equal(percentOf({}), 0);
    assert.equal(percentOf({ size: 100, sizeLeft: 0 }), 100);
    assert.equal(percentOf({ size: 100, sizeLeft: 250 }), 0);
    assert.equal(percentOf({ size: 100, sizeLeft: -20 }), 100);
});

test('ETA prefers estimatedCompletionTime, falls back to timeLeft, and ignores the past', () => {
    const etaOf = (raw) => extractSeerrDownloads({ downloadStatus: [raw] }, NOW)[0].etaMs;
    assert.equal(etaOf({ estimatedCompletionTime: inMinutes(5), timeLeft: '02:00:00' }), 5 * 60000);
    assert.equal(etaOf({ timeLeft: '00:18:30' }), (18 * 60 + 30) * 1000);
    assert.equal(etaOf({ timeLeft: '1.02:00:00' }), 26 * 3600000);
    assert.equal(etaOf({ estimatedCompletionTime: inMinutes(-5), timeLeft: '00:01:00' }), 60000);
    assert.equal(etaOf({ estimatedCompletionTime: inMinutes(-5) }), null);
    assert.equal(etaOf({ estimatedCompletionTime: 'garbage', timeLeft: 'garbage' }), null);
    assert.equal(etaOf({ timeLeft: '00:00:00' }), null);
});

test('splitSeerrEta rounds up to whole minutes and rejects non-positive input', () => {
    assert.deepEqual(splitSeerrEta(1), { hours: 0, minutes: 1 });
    assert.deepEqual(splitSeerrEta(18 * 60000), { hours: 0, minutes: 18 });
    assert.deepEqual(splitSeerrEta(125 * 60000 + 1), { hours: 2, minutes: 6 });
    assert.equal(splitSeerrEta(0), null);
    assert.equal(splitSeerrEta(-5), null);
    assert.equal(splitSeerrEta(null), null);
    assert.equal(splitSeerrEta(NaN), null);
});

test('normalizeSeerrItem exposes downloads and defaults to an empty list', () => {
    assert.deepEqual(normalizeSeerrItem({ id: 1, mediaType: 'movie' })._downloads, []);
    const item = normalizeSeerrItem({
        id: 1,
        mediaType: 'movie',
        mediaInfo: { status: 3, downloadStatus: [{ size: 4, sizeLeft: 1 }] }
    });
    assert.equal(item._downloads.length, 1);
    assert.equal(item._downloads[0].percent, 75);
});

// ----------------------------------------------------------------------------
// Poll cadence and badge (seerrNormalize)
// ----------------------------------------------------------------------------

const item = (fields) => ({ _mediaType: 'tv', _seerrStatus: SEERR_STATUS.NOT_REQUESTED, _downloads: [], ...fields });

test('poll cadence: fast while downloading, slow while waiting, off otherwise', () => {
    const running = [{ percent: 10 }];
    assert.equal(seerrDownloadPollDelay(item({ _downloads: running })), SEERR_DOWNLOAD_POLL_ACTIVE_MS);
    assert.equal(seerrDownloadPollDelay(item({ _seerrStatus: SEERR_STATUS.PROCESSING })), SEERR_DOWNLOAD_POLL_IDLE_MS);
    assert.equal(seerrDownloadPollDelay(item({ _seerrStatus: SEERR_STATUS.AVAILABLE })), 0);
    assert.equal(seerrDownloadPollDelay(null), 0);
});

test('download badge mirrors Seerr: first download, S1E3 or S1 tag, ETA split', () => {
    const download = (fields) => ({
        percent: 42,
        season: 1,
        episode: 3,
        isSeasonPack: false,
        etaMs: 18 * 60000,
        ...fields
    });
    assert.deepEqual(describeSeerrDownloadBadge(item({ _downloads: [download({})] })), {
        percent: 42,
        episodeTag: 'S1E3',
        eta: { hours: 0, minutes: 18 }
    });
    const pack = describeSeerrDownloadBadge(
        item({ _downloads: [download({ season: 17, isSeasonPack: true, episode: null })] })
    );
    assert.equal(pack.episodeTag, 'S17');
    const movie = describeSeerrDownloadBadge(
        item({ _mediaType: 'movie', _downloads: [download({ season: null, episode: null, etaMs: null })] })
    );
    assert.deepEqual(movie, { percent: 42, episodeTag: '', eta: null });
    assert.equal(describeSeerrDownloadBadge(item({})), null);
});

// ----------------------------------------------------------------------------
// Download poller (fake clock)
// ----------------------------------------------------------------------------

/** Manual clock: timers only fire on advance(), then pending promises settle. */
function fakeClock() {
    let now = 0;
    let nextId = 0;
    const timers = new Map();
    const settle = async () => {
        for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return {
        timers: {
            setTimeout: (fn, ms) => {
                timers.set(++nextId, { fn, at: now + ms });
                return nextId;
            },
            clearTimeout: (id) => timers.delete(id)
        },
        pending: () => timers.size,
        settle,
        async advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.fn();
                }
            }
            await settle();
        }
    };
}

/** Builds a poller whose fetch resolves only when the test says so. */
function pollerHarness({ delay = 1000, paused = false } = {}) {
    const clock = fakeClock();
    const calls = { fetch: 0, updates: [], errors: [] };
    const state = { delay, paused, respond: null, fail: null };
    const poller = new SeerrDownloadPoller({
        fetch: () => {
            calls.fetch++;
            return new Promise((resolve, reject) => {
                state.respond = resolve;
                state.fail = reject;
            });
        },
        getDelay: () => state.delay,
        isPaused: () => state.paused,
        onUpdate: (fresh, isStale) => calls.updates.push({ fresh, isStale, staleDuringUpdate: isStale() }),
        onError: (err) => calls.errors.push(err),
        timers: clock.timers
    });
    return { clock, calls, state, poller };
}

test('poller fetches after the delay, hands over the result and re-arms', async () => {
    const { clock, calls, state, poller } = pollerHarness();
    poller.schedule();
    await clock.advance(999);
    assert.equal(calls.fetch, 0);
    await clock.advance(1);
    assert.equal(calls.fetch, 1);
    state.respond({ n: 1 });
    await clock.settle();
    assert.deepEqual(
        calls.updates.map((u) => u.fresh),
        [{ n: 1 }]
    );
    assert.equal(calls.updates[0].staleDuringUpdate, false);
    assert.equal(clock.pending(), 1);
});

test('poller stays idle when there is nothing to watch', async () => {
    const { clock, calls, poller } = pollerHarness({ delay: 0 });
    poller.schedule();
    await clock.advance(100000);
    assert.equal(calls.fetch, 0);
    assert.equal(clock.pending(), 0);
});

test('a paused tick fetches nothing and tries again later', async () => {
    const { clock, calls, state, poller } = pollerHarness({ paused: true });
    poller.schedule();
    await clock.advance(1000);
    assert.equal(calls.fetch, 0);
    assert.equal(clock.pending(), 1);
    state.paused = false;
    await clock.advance(1000);
    assert.equal(calls.fetch, 1);
});

test('a response that arrives while paused is dropped', async () => {
    const { clock, calls, state, poller } = pollerHarness();
    poller.schedule();
    await clock.advance(1000);
    state.paused = true;
    state.respond({ late: true });
    await clock.settle();
    assert.equal(calls.updates.length, 0);
    assert.equal(clock.pending(), 1);
});

test('rescheduling discards the response in flight and never doubles the timer', async () => {
    const { clock, calls, state, poller } = pollerHarness();
    poller.schedule();
    await clock.advance(1000);
    poller.schedule(); // e.g. the user just cancelled the request
    state.respond({ stale: true });
    await clock.settle();
    assert.equal(calls.updates.length, 0);
    assert.equal(clock.pending(), 1);
});

test('stop discards the response in flight and ends polling', async () => {
    const { clock, calls, state, poller } = pollerHarness();
    poller.schedule();
    await clock.advance(1000);
    poller.stop();
    state.respond({ late: true });
    await clock.settle();
    assert.equal(calls.updates.length, 0);
    assert.equal(clock.pending(), 0);
    poller.schedule();
    assert.equal(clock.pending(), 0);
});

test('an update reports stale once the poller moved on, and errors keep polling alive', async () => {
    const { clock, calls, state, poller } = pollerHarness();
    poller.schedule();
    await clock.advance(1000);
    state.respond({ n: 1 });
    await clock.settle();
    const { isStale } = calls.updates[0];
    poller.schedule();
    assert.equal(isStale(), true);

    await clock.advance(1000);
    state.fail(new Error('offline'));
    await clock.settle();
    assert.equal(calls.errors.length, 1);
    assert.equal(clock.pending(), 1);
});

// ----------------------------------------------------------------------------
// Source-level guards for what node cannot render (page DOM, card cache, client)
// ----------------------------------------------------------------------------

/** Returns the source of one class method, from its signature to the next method at the same indent. */
function methodSource(source, signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.notEqual(start, -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    assert.notEqual(end, -1);
    return source.slice(start, end);
}

test('the page refresh path never moves focus and patches the badge in place', () => {
    const page = readFileSync('src/pages/SeerrDetailsPage.js', 'utf8').replace(/\r\n/g, '\n');
    const refreshPath = [
        '_statusBadgeMarkup() {',
        '_renderStatus() {',
        '_patchStatusBadge(current, next) {',
        'async _applyPolledState(fresh, isStale) {',
        '_applyPolledActionState(focusedEl) {'
    ];
    for (const signature of refreshPath) {
        const body = methodSource(page, signature);
        assert.ok(!/focusElement\(|setActiveSection\(/.test(body), `${signature} must not move focus`);
        assert.ok(!/clearResponseCache\(/.test(body), `${signature} must not clear response caches`);
    }

    // Hiding a focused button is deferred instead of applied
    assert.match(
        methodSource(page, '_applyPolledActionState(focusedEl) {'),
        /this\._pendingActionUpdate = true;\s*return;/
    );

    // Same kind of badge: patch, never remove or re-insert
    assert.match(
        methodSource(page, '_renderStatus() {'),
        /existing\[0\]\.className === next\.className\) \{\s*this\._patchStatusBadge\(existing\[0\], next\);\s*return;/
    );
    assert.ok(!/remove\(|innerHTML|insertBefore/.test(methodSource(page, '_patchStatusBadge(current, next) {')));

    // Polling pauses behind modals and recognises the router's lazy-loading proxy
    const paused = methodSource(page, '_isDownloadPollPaused() {');
    assert.match(paused, /focusManager\.isTrapped\(\)/);
    assert.match(paused, /current\._realInstance !== this/);
    assert.match(methodSource(page, 'destroy() {'), /this\._downloadPoller\.stop\(\)/);
});

test('a fresh request bypasses the cache read without clearing focus-restoring caches', () => {
    const client = readFileSync('src/api/seerrClient.js', 'utf8').replace(/\r\n/g, '\n');
    const request = methodSource(client, 'async _request(path, options = {}) {');
    assert.match(request, /options\.fresh \? null : this\._cache\.get\(cacheKey\)/);
    // clearResponseCache (which drops discover:pageCache) stays limited to POST and DELETE
    const getBranch = request.slice(request.indexOf('const now = Date.now();'));
    assert.ok(!/clearResponseCache\(\)/.test(getBranch));
});

test('cards with a running download bypass the card HTML cache', () => {
    const renderer = readFileSync('src/utils/CardRenderer.js', 'utf8');
    assert.match(renderer, /hasSeerrDownloads \? undefined : CardRenderer\._htmlCache\.get\(itemCacheKey\)/);
    assert.match(renderer, /if \(!hasSeerrDownloads\) CardRenderer\._htmlCache\.set\(itemCacheKey, html\);/);
});

test('every shipped locale defines the download strings', () => {
    const keys = ['SeerrStatusDownloading', 'SeerrDownloadInMinutes', 'SeerrDownloadInHoursMinutes'];
    for (const locale of ['en-us', 'de']) {
        const dictionary = JSON.parse(readFileSync(`src/locales/${locale}.json`, 'utf8'));
        for (const key of keys) assert.ok(dictionary[key], `${locale} is missing ${key}`);
    }
});
