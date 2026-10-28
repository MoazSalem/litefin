import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * PlayerPage Item Switch Stop Report Test Suite
 * ============================================================================
 * Next, Previous and auto-advance waited for the stop report of the item
 * being left before starting the next one: on a stalled server, its full
 * timeout (up to 11 s), while Back waits at most 2.5 s and restarts don't
 * wait. The next item now starts at once, and its start report (and its
 * progress reports) still go out only after the stop report of the item that
 * was left. A Live TV channel switch still waits, at most 2.5 s, for the old
 * live stream to close, and Back waits for the previous item's report too.
 * The PlayerPage methods under test are taken from the source and run on a
 * stub page (the module itself needs a full DOM).
 * ============================================================================
 */

const source = readFileSync(new URL('../src/pages/PlayerPage.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Source of one class method, from its signature to the closing brace at method indentation. */
function extractMethod(signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

function extractConstant(name) {
    const match = source.match(new RegExp(`\\nconst ${name} = [^;]+;`));
    assert.ok(match, `constant not found: ${name}`);
    return match[0];
}

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
    let resolve;
    const promise = new Promise((res) => (resolve = res));
    return { promise, resolve };
}

const DURATION = 72000000000;

/**
 * Stub page playing item A (session A1, start reported). The stop report of
 * A1, and the close of its live stream with `live`, are answered only when the
 * test says so (a stalled server).
 */
function createPage({ repeatMode = 'RepeatNone', live = false } = {}) {
    const requests = [];
    const startInfos = [];
    const navigations = [];
    const stopA1 = deferred();
    const closeA = deferred();
    const type = live ? 'TvChannel' : 'Episode';
    const itemA = { Id: 'A', Type: type, RunTimeTicks: DURATION };
    const itemB = { Id: 'B', Type: type, RunTimeTicks: DURATION };

    const api = {
        serverUrl: 'http://srv',
        getAuthHeader: () => '',
        isEmby: () => false,
        clearEtagCache() {},
        closeLiveStream(liveStreamId) {
            requests.push(`close:${liveStreamId}`);
            return closeA.promise;
        },
        reportPlaybackStopped(data) {
            requests.push(`stop:${data.PlaySessionId}`);
            return data.PlaySessionId === 'A1' ? stopA1.promise : Promise.resolve(null);
        },
        async reportPlaybackStart(info) {
            requests.push(`start:${info.PlaySessionId}`);
            startInfos.push(info);
        },
        async reportPlaybackProgress(info) {
            requests.push(`progress:${info.PlaySessionId}:${info.EventName}`);
        }
    };
    const playQueue = {
        hasNext: () => true,
        advance: () => itemB,
        hasPrevious: () => true,
        goBack: () => itemB,
        getRepeatMode: () => repeatMode,
        getQueue: () => [itemA, itemB],
        getCurrentItem: () => null,
        stampPlaylistItemId: () => 'playlist-item'
    };
    const context = vm.createContext({
        setTimeout,
        clearTimeout,
        Promise,
        JSON,
        Math,
        log: quietLog,
        api,
        window: {},
        XMLHttpRequest: class {},
        playQueue,
        state: { get: () => null, delete() {}, getAll: () => ({}) },
        pluginManager: { notifyPlayerStop() {} },
        eventBus: { emit() {} },
        platformInfo: { isWeb: false, isAndroid: false },
        router: {
            navigate: (path) => navigations.push(path),
            back: () => navigations.push('back')
        }
    });
    const methods = vm.runInContext(
        `${extractConstant('STOP_REPORT_TIMEOUT_MS')}\n${extractConstant('STOP_REPORT_EXIT_WAIT_MS')}\n({\n${[
            '_onEnded() {',
            'async _playNextItem() {',
            'async _playPreviousItem() {',
            'async _switchChannel(nextChannel) {',
            'async _stopAndExit(',
            '_onPlayerRestarting() {',
            'async _reportPlaybackStart() {',
            'async _reportPlaybackProgress(',
            'async _awaitStopReportBeforeExit(report) {',
            'async _reportPlaybackStoppedOnSwitch(',
            'async _reportPlaybackStopped('
        ]
            .map(extractMethod)
            .join(',\n')}\n})`,
        context
    );

    let mediaSource = { Id: 'A', PlaySessionId: 'A1', RunTimeTicks: DURATION };
    if (live) mediaSource.LiveStreamId = 'live-A';
    let position = 6000000000;
    const started = [];
    const page = Object.assign(Object.create(methods), {
        params: {},
        title: '',
        _item: itemA,
        _hasReportedStart: true,
        _isGhostMode: false,
        _isExiting: false,
        _isSwitching: false,
        _isPlaybackEnded: false,
        _hasPlayerError: false,
        _isPaused: false,
        _resumePosition: 0,
        _pendingStopReport: null,
        _waitingStartReport: null,
        _unstartedRestart: null,
        _cachedPlayMethod: 'DirectPlay',
        _osd: null,
        _player: {
            stop: async () => {},
            seek() {},
            getCurrentMediaSource: () => mediaSource,
            getCurrentPositionTicks: () => position,
            getDurationTicks: () => DURATION
        },
        _clearPlaybackStallWatchdog() {},
        _showLoading() {},
        _showError(message) {
            throw new Error(message);
        },
        _captureActiveTrackSelection() {},
        _updateLiveTvTitle() {},
        _getWatchedThresholdFraction: () => 0.8,
        _buildNowPlayingQueue: () => [],
        _getPlayerState: () => ({ PositionTicks: position }),
        /** play() of the next item: its PlaybackInfo answers with a new session */
        async _startPlayback() {
            started.push(this._item.Id);
            mediaSource = { Id: this._item.Id, PlaySessionId: `${this._item.Id}${started.length + 1}` };
        }
    });

    return {
        page,
        requests,
        startInfos,
        navigations,
        started,
        stopA1,
        closeA,
        itemB,
        setPosition: (ticks) => (position = ticks),
        /** The new session plays: PlayerPage sets the guard, then reports */
        sessionPlays() {
            page._hasReportedStart = true;
            return page._reportPlaybackStart();
        }
    };
}

for (const [name, run] of [
    ['Next', (page) => page._playNextItem()],
    ['Previous', (page) => page._playPreviousItem()]
]) {
    test(`PlayerPage: ${name} starts the other item without waiting for the stop report`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { page, requests, started, stopA1, sessionPlays } = createPage();

        const switching = run(page);
        await flush();
        t.mock.timers.tick(500); // settle delay
        await switching;
        assert.deepStrictEqual(started, ['B'], 'the item switched to waits for the stop report of the one left');

        // B plays while the server still has not answered stop(A1)
        const starting = sessionPlays();
        await flush();
        assert.deepStrictEqual(requests, ['stop:A1'], 'B was reported before A stopped');

        stopA1.resolve(null);
        await starting;
        assert.deepStrictEqual(requests, ['stop:A1', 'start:B2']);
        assert.strictEqual(page._pendingStopReport, null);
    });
}

test('PlayerPage: with a stalled server the next item reports its start once the stop report times out', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { page, requests, started, sessionPlays } = createPage();

    const switching = page._playNextItem();
    await flush();
    t.mock.timers.tick(500);
    await switching;
    assert.deepStrictEqual(started, ['B']);

    let reported = false;
    const starting = sessionPlays().then(() => (reported = true));
    t.mock.timers.tick(10000);
    await flush();
    assert.ok(!reported, 'the next item was reported before the previous one stopped');
    t.mock.timers.tick(500); // STOP_REPORT_TIMEOUT_MS + 1 s after stop(A1) was sent
    await flush();
    await starting;
    assert.deepStrictEqual(requests, ['stop:A1', 'start:B2']);
});

test('PlayerPage: RepeatOne plays the item again without waiting for the stop report', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { page, requests, started, stopA1, sessionPlays } = createPage({ repeatMode: 'RepeatOne' });

    page._onEnded();
    await flush();
    t.mock.timers.tick(500); // settle delay
    await flush();
    assert.deepStrictEqual(started, ['A'], 'the item waits for its stop report before playing again');

    const starting = sessionPlays();
    await flush();
    assert.deepStrictEqual(requests, ['stop:A1']);

    stopA1.resolve(null);
    await starting;
    assert.deepStrictEqual(requests, ['stop:A1', 'start:A2']);
});

test('PlayerPage: a restart of the next item before it plays keeps the previous stop report first', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { page, requests, started, stopA1, sessionPlays } = createPage();

    const switching = page._playNextItem();
    await flush();
    t.mock.timers.tick(500);
    await switching;
    assert.deepStrictEqual(started, ['B']);

    // webOS: the preferred audio track is not the file's default, so B restarts before it plays
    page._onPlayerRestarting();
    const starting = sessionPlays();
    await flush();
    assert.deepStrictEqual(requests, ['stop:A1'], 'the next item was reported before the previous one stopped');

    stopA1.resolve(null);
    await starting;
    assert.deepStrictEqual(requests, ['stop:A1', 'start:B2']);
});

test('PlayerPage: the next item reports no progress before its start report', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { page, requests, startInfos, stopA1, sessionPlays, setPosition } = createPage();

    const switching = page._playNextItem();
    await flush();
    t.mock.timers.tick(500);
    await switching;

    // B plays: its start waits for stop(A1); the first time update and a pause follow
    setPosition(100000000);
    const starting = sessionPlays();
    await page._reportPlaybackProgress('timeupdate');
    page._isPaused = true;
    setPosition(150000000);
    await page._reportPlaybackProgress('pause');
    await flush();
    assert.deepStrictEqual(requests, ['stop:A1'], 'B reported progress before A stopped and B started');

    stopA1.resolve(null);
    await starting;
    assert.deepStrictEqual(requests, ['stop:A1', 'start:B2']);
    // The start reports the state at the time it is sent
    assert.strictEqual(startInfos[0].PositionTicks, 150000000);
    assert.strictEqual(startInfos[0].IsPaused, true);

    await page._reportPlaybackProgress('pause');
    assert.deepStrictEqual(requests, ['stop:A1', 'start:B2', 'progress:B2:pause']);
});

test('PlayerPage: a Live TV channel switch waits for the old live stream to close', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { page, requests, started, stopA1, closeA, itemB } = createPage({ live: true });
    stopA1.resolve(null);

    const switching = page._switchChannel(itemB);
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.deepStrictEqual(started, [], 'the next channel opens a stream while the old one is still open');

    closeA.resolve();
    await flush();
    t.mock.timers.tick(400); // settle delay
    await switching;
    assert.deepStrictEqual(started, ['B']);
    assert.deepStrictEqual(requests, ['close:live-A', 'stop:A1']);
});

test('PlayerPage: a Live TV channel switch waits at most 2.5 s for a server that does not answer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { page, started, itemB } = createPage({ live: true });

    const switching = page._switchChannel(itemB);
    await flush();
    t.mock.timers.tick(2400);
    await flush();
    assert.deepStrictEqual(started, []);
    t.mock.timers.tick(100);
    await flush();
    t.mock.timers.tick(400); // settle delay
    await switching;
    assert.deepStrictEqual(started, ['B']);
});

test('PlayerPage: Back after Next also waits for the stop report of the item left by Next', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { page, navigations, stopA1, sessionPlays } = createPage();

    const switching = page._playNextItem();
    await flush();
    t.mock.timers.tick(500);
    await switching;
    sessionPlays();

    const leaving = page._stopAndExit();
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.deepStrictEqual(navigations, [], "left before A's new resume position reached the server");

    stopA1.resolve(null);
    await flush();
    // Advance mock timers past the SQLite write settle delay in _stopAndExit
    t.mock.timers.tick(200);
    await leaving;
    assert.deepStrictEqual(navigations, ['/details/B']);
});

test('PlayerPage: Back after Next still leaves after 2.5 s when the server does not answer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { page, navigations, sessionPlays } = createPage();

    const switching = page._playNextItem();
    await flush();
    t.mock.timers.tick(500);
    await switching;
    sessionPlays();

    const leaving = page._stopAndExit();
    await flush();
    t.mock.timers.tick(2500);
    await flush();
    // Advance mock timers past the SQLite write settle delay in _stopAndExit
    t.mock.timers.tick(200);
    await leaving;
    assert.deepStrictEqual(navigations, ['/details/B']);
});
