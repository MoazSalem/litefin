import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * PlayerPage Restarted Session Stop Report Test Suite
 * ============================================================================
 * A restart (audio track switch, quality change, fallback) replaces the
 * playing session with a new one, which reports its start only once it
 * plays. Back, Next or another restart before then sent no stop report for
 * it, so its transcode ran on the server until Jellyfin's ping timeout. It
 * is now stopped too, at the position the user was at when the restart
 * began. A session that never played without a restart is still not
 * reported, so a failed start cannot overwrite the resume position.
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

const DURATION = 72000000000;
const WATCHED = 6000000000; // 10 min into the item when the restart begins

function createPage() {
    const requests = [];
    const api = {
        serverUrl: 'http://srv',
        getAuthHeader: () => '',
        isEmby: () => false,
        closeLiveStream: async () => {},
        async reportPlaybackStopped(data) {
            requests.push(`stop:${data.PlaySessionId}@${data.PositionTicks}`);
            return null;
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

    let mediaSource = { Id: 'source', PlaySessionId: 'S1', RunTimeTicks: DURATION };
    let position = WATCHED;
    const page = Object.assign(Object.create(methods), {
        _item: { Id: 'item', RunTimeTicks: DURATION },
        _hasReportedStart: true,
        _isGhostMode: false,
        _isExiting: false,
        _resumePosition: WATCHED,
        _pendingStopReport: null,
        _waitingStartReport: null,
        _unstartedRestart: null,
        _cachedPlayMethod: 'DirectPlay',
        _player: {
            getCurrentMediaSource: () => mediaSource,
            getCurrentPositionTicks: () => position,
            getDurationTicks: () => DURATION
        },
        _clearPlaybackStallWatchdog() {},
        _showLoading() {},
        _getWatchedThresholdFraction: () => 0.8,
        _buildNowPlayingQueue: () => [],
        _getPlayerState: () => ({ PositionTicks: position })
    });

    return {
        page,
        requests,
        /** The restart's PlaybackInfo answered: the player holds the new session, still loading */
        newSession(playSessionId, loadingPosition = 0) {
            mediaSource = { Id: 'source', PlaySessionId: playSessionId, RunTimeTicks: DURATION };
            position = loadingPosition;
        },
        /** The new session plays */
        async sessionPlays(atPosition) {
            position = atPosition;
            page._hasReportedStart = true;
            await page._reportPlaybackStart();
        },
        /** Back: _stopAndExit captures the session, stops the player and reports */
        async pressBack() {
            page._isExiting = true;
            const source = page._player.getCurrentMediaSource();
            const ticks = page._player.getCurrentPositionTicks() || page._resumePosition;
            await page._awaitStopReportBeforeExit(page._reportPlaybackStopped(source, ticks, false, DURATION));
        }
    };
}

test('PlayerPage: Back before a restarted session plays stops it at the restart position', async () => {
    const { page, requests, newSession, pressBack } = createPage();

    // Audio track switch to a track that needs a transcode
    page._onPlayerRestarting();
    newSession('S2', 1234);
    await pressBack();

    assert.deepStrictEqual(
        requests,
        [`stop:S1@${WATCHED}`, `stop:S2@${WATCHED}`],
        'the restarted session keeps transcoding on the server'
    );
});

test('PlayerPage: a second restart before the first one plays stops each replaced session', async () => {
    const { page, requests, newSession, pressBack } = createPage();

    page._onPlayerRestarting();
    newSession('S2');
    // Quality change while S2 is still loading
    page._onPlayerRestarting();
    await flush();
    newSession('S3');
    await pressBack();

    assert.deepStrictEqual(requests, [`stop:S1@${WATCHED}`, `stop:S2@${WATCHED}`, `stop:S3@${WATCHED}`]);
});

test('PlayerPage: Back while the restart still asks for its new session does not stop the old one twice', async () => {
    const { page, requests, pressBack } = createPage();

    page._onPlayerRestarting();
    // PlaybackInfo for the new session not answered yet: the player still holds S1
    await pressBack();

    assert.deepStrictEqual(requests, [`stop:S1@${WATCHED}`]);
});

test('PlayerPage: once the restarted session plays, it is reported as usual', async () => {
    const { page, requests, newSession, sessionPlays, pressBack } = createPage();

    page._onPlayerRestarting();
    await flush();
    newSession('S2');
    await sessionPlays(WATCHED + 300000000);
    assert.strictEqual(page._unstartedRestart, null);
    await pressBack();

    assert.deepStrictEqual(requests, [`stop:S1@${WATCHED}`, 'start:S2', `stop:S2@${WATCHED + 300000000}`]);
});

test('PlayerPage: a session that never played without a restart is still not reported', async () => {
    const { page, requests, newSession, pressBack } = createPage();

    // First start of the item, still loading
    page._hasReportedStart = false;
    newSession('S1');
    await pressBack();

    assert.deepStrictEqual(requests, [], 'a stop report for a start that never played overwrites the resume position');
});

test('PlayerPage: the next item is not stopped at the restart position of the previous one', async () => {
    const { page, requests, newSession, pressBack } = createPage();
    const outgoing = page._item;

    page._onPlayerRestarting();
    newSession('S2');
    // Next before S2 plays: the outgoing item's restarted session is stopped
    await page._reportPlaybackStopped(page._player.getCurrentMediaSource(), 0, false, DURATION, outgoing);

    // The next item is loading when the user presses Back
    page._item = { Id: 'next-item', RunTimeTicks: DURATION };
    page._resumePosition = 0;
    newSession('N1');
    await pressBack();

    assert.deepStrictEqual(requests, [`stop:S1@${WATCHED}`, `stop:S2@${WATCHED}`]);
});
