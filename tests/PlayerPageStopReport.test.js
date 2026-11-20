import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * PlayerPage Stop Report Test Suite
 * ============================================================================
 * A synchronous XHR blocks the TV's UI thread (and the loading spinner) for a
 * full server round trip, or until the TCP timeout when the server is
 * unreachable. Only app exit may use one; restarts and failed reports use
 * asynchronous requests, and a restart's stop report still reaches the
 * server before the new session's start report.
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
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createPage({ reportStopped }) {
    const requests = [];
    const syncXhrSends = [];

    class RecordingXhr {
        open(method, url, async) {
            this.sync = async === false;
        }
        setRequestHeader() {}
        send(body) {
            if (this.sync) syncXhrSends.push(JSON.parse(body));
            this.status = 204;
        }
    }

    const api = {
        serverUrl: 'http://srv',
        accessToken: 'token',
        getAuthHeader: () => 'MediaBrowser Token="token"',
        isEmby: () => false,
        closeLiveStream: async () => {},
        reportPlaybackStopped(data, options) {
            requests.push({ type: 'stop', session: data.PlaySessionId, options });
            return reportStopped(data, options);
        },
        async reportPlaybackStart(info) {
            requests.push({ type: 'start', session: info.PlaySessionId });
        }
    };

    const context = vm.createContext({
        setTimeout,
        clearTimeout,
        Promise,
        JSON,
        Math,
        log: quietLog,
        api,
        XMLHttpRequest: RecordingXhr,
        window: {},
        playQueue: {
            getQueue: () => [],
            getCurrentItem: () => null,
            stampPlaylistItemId: () => 'playlist-item'
        }
    });
    const methods = vm.runInContext(
        `${extractConstant('STOP_REPORT_TIMEOUT_MS')}\n${extractConstant('STOP_REPORT_EXIT_WAIT_MS')}\n({\n${[
            '_onPlayerRestarting() {',
            'async _reportPlaybackStart() {',
            'async _awaitStopReportBeforeExit(report) {',
            'async _reportPlaybackStopped('
        ]
            .map(extractMethod)
            .join(',\n')}\n})`,
        context
    );

    let mediaSource = { Id: 'source', PlaySessionId: 'old', RunTimeTicks: 72000000000 };
    const page = Object.assign(Object.create(methods), {
        _item: { Id: 'item', RunTimeTicks: 72000000000 },
        _hasReportedStart: true,
        _isGhostMode: false,
        _isPlaybackEnded: false,
        _resumePosition: 0,
        _pendingStopReport: null,
        _cachedPlayMethod: 'Transcode',
        _player: {
            getCurrentMediaSource: () => mediaSource,
            getCurrentPositionTicks: () => 6000000000,
            getDurationTicks: () => 72000000000
        },
        _clearPlaybackStallWatchdog() {},
        _showLoading() {},
        _getWatchedThresholdFraction: () => 0.8,
        _buildNowPlayingQueue: () => [],
        _getPlayerState: () => ({ PositionTicks: 0 })
    });
    return {
        page,
        requests,
        syncXhrSends,
        setMediaSource: (next) => (mediaSource = next)
    };
}

test('PlayerPage: a restart reports the old session without a synchronous XHR, before the new session starts', async () => {
    const stop = deferred();
    const { page, requests, syncXhrSends, setMediaSource } = createPage({ reportStopped: () => stop.promise });

    page._onPlayerRestarting();
    assert.strictEqual(syncXhrSends.length, 0, 'UI thread blocked by a synchronous stop report');
    assert.deepStrictEqual(
        requests.map((r) => `${r.type}:${r.session}`),
        ['stop:old']
    );
    assert.strictEqual(page._hasReportedStart, false);

    // The restarted session starts playing while the stop report is in flight
    setMediaSource({ Id: 'source', PlaySessionId: 'new' });
    const starting = page._reportPlaybackStart();
    await flush();
    assert.deepStrictEqual(
        requests.map((r) => `${r.type}:${r.session}`),
        ['stop:old'],
        'new session reported before the old one was stopped'
    );

    stop.resolve(null);
    await starting;
    assert.deepStrictEqual(
        requests.map((r) => `${r.type}:${r.session}`),
        ['stop:old', 'start:new']
    );
    assert.strictEqual(page._pendingStopReport, null);
});

test('PlayerPage: a failed restart stop report does not hold back the new session', async () => {
    const { page, requests, setMediaSource } = createPage({
        reportStopped: () => Promise.reject(new Error('network'))
    });

    page._onPlayerRestarting();
    setMediaSource({ Id: 'source', PlaySessionId: 'new' });
    await page._reportPlaybackStart();
    assert.ok(requests.some((r) => r.type === 'start' && r.session === 'new'));
});

test('PlayerPage: a failed stop report is retried asynchronously, never with a synchronous XHR', async () => {
    let attempts = 0;
    const { page, requests, syncXhrSends } = createPage({
        reportStopped: () => (++attempts === 1 ? Promise.reject(new Error('network')) : Promise.resolve(null))
    });

    await page._reportPlaybackStopped(null, 6000000000, false, 72000000000);
    await flush();

    assert.strictEqual(syncXhrSends.length, 0, 'synchronous XHR fallback blocks the UI until the TCP timeout');
    assert.strictEqual(attempts, 2);
    assert.ok(
        requests.every((r) => r.options?.timeout > 0),
        'an asynchronous stop report without a timeout can hold Back forever'
    );
});

test('PlayerPage: app exit still sends the stop report with a synchronous XHR', async () => {
    const { page, requests, syncXhrSends } = createPage({ reportStopped: () => Promise.resolve(null) });

    await page._reportPlaybackStopped(null, 6000000000, true, 72000000000);

    assert.strictEqual(syncXhrSends.length, 1);
    assert.strictEqual(syncXhrSends[0].PlaySessionId, 'old');
    assert.strictEqual(syncXhrSends[0].PositionTicks, 6000000000);
    assert.strictEqual(requests.length, 0);
});

test('PlayerPage: Back stops waiting for a stop report that never answers, even without a real AbortController', async (t) => {
    // Chromium < 66 (webOS 3/4, Tizen 3–5) only has a polyfilled AbortController,
    // which cannot abort fetch(): ApiClient's timeout never fires there
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const { page } = createPage({
        reportStopped: () => {
            attempts++;
            return new Promise(() => {});
        }
    });

    let finished = false;
    page._reportPlaybackStopped(null, 6000000000, false, 72000000000).then(() => (finished = true));
    for (let i = 0; i < 12; i++) {
        t.mock.timers.tick(1000);
        await flush();
    }
    assert.ok(finished, 'Back still waiting on the stop report');
    assert.strictEqual(attempts, 1, 'a request that may still arrive was sent again');
});

test('PlayerPage: Back leaves the player after 2.5 s when the server does not answer the stop report', async (t) => {
    // LG C4 with Jellyfin unresponsive: the spinner stayed up for the full 10 s timeout
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { page } = createPage({ reportStopped: () => new Promise(() => {}) });

    let left = false;
    page._awaitStopReportBeforeExit(page._reportPlaybackStopped(null, 6000000000, false, 72000000000)).then(() => (left = true));
    t.mock.timers.tick(2400);
    await flush();
    assert.ok(!left, 'left before a healthy server could answer');
    t.mock.timers.tick(100);
    await flush();
    assert.ok(left, 'Back held until the stop report timed out');
});

test('PlayerPage: Back leaves as soon as the stop report is answered', async () => {
    const { page } = createPage({ reportStopped: () => Promise.resolve(null) });
    await page._awaitStopReportBeforeExit(page._reportPlaybackStopped(null, 6000000000, false, 72000000000));
});
