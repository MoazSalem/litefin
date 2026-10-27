import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * PlayerPage Start Report After Stop Test Suite
 * ============================================================================
 * After a restart, the new session's PlaybackStart waits for the old
 * session's stop report. If the user presses Back (or another restart
 * replaces the session) while it waits, that session's stop report goes out
 * first, and a start sent afterwards showed the item as playing on the server
 * (and Trakt) after the user left. The waiting start is now dropped.
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
    const promise = new Promise((res) => (resolve = res));
    return { promise, resolve };
}

/**
 * Stub page with the restart, start and stop report methods. Stop reports for
 * the sessions in `slowStops` are answered only when the test says so.
 */
function createPage(slowStops = {}) {
    const requests = [];
    const api = {
        serverUrl: 'http://srv',
        getAuthHeader: () => '',
        isEmby: () => false,
        closeLiveStream: async () => {},
        reportPlaybackStopped(data) {
            requests.push(`stop:${data.PlaySessionId}`);
            return slowStops[data.PlaySessionId]?.promise || Promise.resolve(null);
        },
        async reportPlaybackStart(info) {
            requests.push(`start:${info.PlaySessionId}`);
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
        window: {},
        XMLHttpRequest: class {},
        playQueue: { getQueue: () => [], getCurrentItem: () => null, stampPlaylistItemId: () => 'playlist-item' }
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

    let mediaSource = { Id: 'source', PlaySessionId: 'S1', RunTimeTicks: 72000000000 };
    const page = Object.assign(Object.create(methods), {
        _item: { Id: 'item', RunTimeTicks: 72000000000 },
        _hasReportedStart: true,
        _isGhostMode: false,
        _isExiting: false,
        _resumePosition: 0,
        _pendingStopReport: null,
        _waitingStartReport: null,
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
        _getPlayerState: () => ({ PositionTicks: 6000000000 })
    });

    /** The restarted session starts playing: PlayerPage sets the guard, then reports */
    const sessionPlays = (playSessionId) => {
        mediaSource = { Id: 'source', PlaySessionId: playSessionId, RunTimeTicks: 72000000000 };
        page._hasReportedStart = true;
        return page._reportPlaybackStart();
    };
    /** Back: _stopAndExit sends the stop report and leaves after at most 2.5 s */
    const pressBack = async () => {
        page._isExiting = true;
        await page._awaitStopReportBeforeExit(
            page._reportPlaybackStopped(page._player.getCurrentMediaSource(), 6000000000, false, 72000000000)
        );
    };
    return { page, requests, sessionPlays, pressBack };
}

test('PlayerPage: Back while a restarted session waits to report its start sends no start after its stop', async () => {
    const stopS1 = deferred();
    const { page, requests, sessionPlays, pressBack } = createPage({ S1: stopS1 });

    // Audio track switch on a slow server: stop(S1) in flight
    page._onPlayerRestarting();
    const starting = sessionPlays('S2');
    await flush();
    assert.deepStrictEqual(requests, ['stop:S1']);

    await pressBack();
    stopS1.resolve(null);
    await starting;

    assert.deepStrictEqual(requests, ['stop:S1', 'stop:S2'], 'the server sees the item playing after the user left');
});

test('PlayerPage: a second restart while the start report waits sends no start for the replaced session', async () => {
    const stopS1 = deferred();
    const { page, requests, sessionPlays } = createPage({ S1: stopS1 });

    page._onPlayerRestarting();
    const startingS2 = sessionPlays('S2');
    await flush();

    // Another restart (quality change) replaces S2 before stop(S1) is answered
    page._onPlayerRestarting();
    await flush();
    const startingS3 = sessionPlays('S3');
    await startingS3;

    stopS1.resolve(null);
    await startingS2;

    assert.deepStrictEqual(requests, ['stop:S1', 'stop:S2', 'start:S3']);
});

test('PlayerPage: the restarted session still reports its start once the old stop report is answered', async () => {
    const stopS1 = deferred();
    const { page, requests, sessionPlays } = createPage({ S1: stopS1 });

    page._onPlayerRestarting();
    const starting = sessionPlays('S2');
    await flush();
    stopS1.resolve(null);
    await starting;

    assert.deepStrictEqual(requests, ['stop:S1', 'start:S2']);
    assert.strictEqual(page._waitingStartReport, null);
});
