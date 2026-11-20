/* eslint-env node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Player Controller Follow-up Test Suite
 * ============================================================================
 * Follow-ups to the player controller (JellyfinPlayer, MediaHelper):
 *   - HLS manifest polling stops at a client error (4xx)
 *   - the global bitrate limit does not force a transcode of the first item
 *   - a failed PlaybackInfo request is reported, not asked again as a transcode
 *   - confirming the mode the Playback Mode menu shows does not restart
 *   - the remux or transcode a restart falls back to stays with its item (also
 *     when the page starts that item again)
 *   - Back or Next while a restart loads ends the restart
 *   - play() resolves false only when the request was cancelled
 *   - a restart during the page's first play() resolves that play() with the
 *     restart, so the page still sets up its OSD
 *   - a slow transcode seek is not taken for a stuck one (also across a new
 *     seek, a pause and Play)
 *   - a spot the server never delivers ends with an error after one reload
 *     and one transcode retry, instead of retrying for good
 * The JellyfinPlayer methods under test are taken from the source and run on
 * a stub player (the module itself needs a full DOM).
 * ============================================================================
 */

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };

const { MediaHelper } = await import('../src/player/core/MediaHelper.js');

const realFetch = globalThis.fetch;
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Advance mocked time in steps, letting promise chains run in between. */
async function advance(t, ms, step = 250) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
        t.mock.timers.tick(step);
        await flush();
    }
}

// ----------------------------------------------------------------------------
// JellyfinPlayer harness
// ----------------------------------------------------------------------------

const source = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
);

/** Source of one class method, from its signature to the closing brace at method indentation. */
function extractMethod(signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

const playerEventSource = source
    .slice(
        source.indexOf('export const PlayerEvent = {'),
        source.indexOf('};', source.indexOf('export const PlayerEvent = {')) + 2
    )
    .replace('export const', 'const');

/** Module-level constants the methods use, as declared in the source. */
const constantsSource = [
    'PLAYBACK_INFO_TIMEOUT_MS',
    'REMUX_WATCHDOG_FIRST_CHECK_MS',
    'REMUX_WATCHDOG_RECHECK_MS',
    'REMUX_WATCHDOG_MAX_MS',
    'REMUX_STUCK_BUFFER_AHEAD_S',
    'RESUME_ADVANCE_WAIT_MS',
    'TRANSCODE_SEEK_STUCK_MS'
]
    .map((name) => {
        const match = source.match(new RegExp(`\\nconst ${name} = [^;]+;`));
        assert.ok(match, `constant not found: ${name}`);
        return match[0];
    })
    .join('\n');

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };

/** Globals the extracted methods use, with the real MediaHelper where it matters. */
function playerGlobals(settings, globals) {
    return {
        // Through the globals, so mocked timers apply
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        Promise,
        Object,
        Number,
        Date,
        JSON,
        Math,
        log: quietLog,
        PlayerSettings: { get: (key) => settings[key] },
        TizenAVPlayer: class {},
        HtmlVideoPlayer: class {},
        platformInfo: {},
        webCodecsProbe: {},
        buildJellyfinProfile: () => ({ Name: 'stub', DirectPlayProfiles: [{}] }),
        resolveBestAudioStream: () => null,
        isAudioTrackNativelyPlayable: () => true,
        doesAudioTrackRequireDirectStream: () => false,
        rememberContainerWithoutAudioTracks: () => {},
        resolveSubtitleStream: () => -1,
        isTrueHdSupported: () => false,
        isDtsSupported: () => false,
        prewarmManager: { consumePlaybackInfo: () => null },
        api: { isEmby: () => false, getAuthHeader: () => 'MediaBrowser Token="t"', getItem: async () => ({}) },
        MediaHelper: {
            getPlayMethod: () => 'DirectPlay',
            buildStreamUrl: ({ itemId, startPositionTicks }) => ({
                url: `http://srv/${itemId}`,
                transcodingOffsetTicks: 0,
                playerStartPositionTicks: startPositionTicks
            }),
            fetchWithTimeout: MediaHelper.fetchWithTimeout
        },
        ...globals
    };
}

/**
 * A backend whose play() stays pending until the test settles it. stop()
 * rejects a pending load as superseded, like the webOS and HTML5 backends.
 */
function createBackend() {
    const backend = {
        loads: [],
        pending: null,
        speeds: [],
        play(options) {
            return new Promise((resolve, reject) => {
                const load = { options, resolve, reject };
                backend.loads.push(load);
                backend.pending = load;
            });
        },
        async stop() {
            const load = backend.pending;
            backend.pending = null;
            if (load) {
                const error = new Error('Playback load was superseded by a newer request');
                error.name = 'AbortError';
                error.superseded = true;
                load.reject(error);
            }
        },
        setSpeed(speed) {
            backend.speeds.push(speed);
        },
        seek() {},
        // The <video> element, for a test that sets its `seeking`
        video: null,
        getVideoElement: () => backend.video,
        getCurrentTime: () => 0,
        supportsNativeAudioTracks: () => true
    };
    return backend;
}

/** Real methods every stub player gets (play() and what it calls). */
const PLAYER_METHODS = [
    'async play(options) {',
    'async stop(options = {}) {',
    '_handleBackendEvent(event) {',
    'getPlaybackMode() {',
    'getMaxBitrate() {',
    '_abandonSupersededPlay(stage) {',
    'async _playAfterRestartPause(options, pauseMs) {',
    '_clearResumeAdvanceWait() {',
    '_isAwaitingResumeAdvance(time) {',
    '_finishResumeWait(message) {',
    'getCurrentPositionTicks() {'
];

/**
 * A stub JellyfinPlayer running the real methods above plus `methods`.
 * PlaybackInfo is answered at once (`player._getPlaybackInfo` can be
 * replaced, or deleted to use the real one from the prototype).
 */
function createPlayer({ methods = [], settings = {}, globals = {} } = {}) {
    const profiles = [];
    const context = vm.createContext(
        playerGlobals(settings, {
            buildJellyfinProfile: (options) => {
                profiles.push(options);
                return { Name: 'stub', DirectPlayProfiles: [{}] };
            },
            ...globals
        })
    );
    const loaded = vm.runInContext(
        `${playerEventSource}\n${constantsSource}\n({ PlayerEvent, methods: {\n${PLAYER_METHODS.concat(methods)
            .map(extractMethod)
            .join(',\n')}\n} })`,
        context
    );
    const backend = createBackend();
    return Object.assign(Object.create(loaded.methods), {
        PlayerEvent: loaded.PlayerEvent,
        backend,
        profiles,
        events: [],
        infoRequests: [],
        armedWatchdogs: [],
        serverUrl: 'http://srv',
        authToken: 't',
        _playRequestId: 0,
        _isRestarting: false,
        _audioRestartInProgress: false,
        _directPlayEscalated: false,
        _isSeeking: false,
        _seekTargetTicks: null,
        _pendingStartPositionTicks: null,
        _resumeLastTime: null,
        _resumeAdvanceTimer: null,
        _transcodingOffsetTicks: 0,
        _remuxWatchdogActive: false,
        _manualBitrate: null,
        _backendType: 'webos',
        _backend: backend,
        _subtitleManager: { setMediaContext() {}, tick() {}, play() {}, pause() {}, resetActiveCues() {} },
        _currentPlayMethod: null,
        _playbackMode: 'auto',
        _userPlaybackMode: 'auto',
        _currentItem: null,
        _currentMediaSource: null,
        _currentPlayOptions: null,
        _lastPlayOptions: null,
        _isPlaying: false,
        _currentSecondarySubtitleStreamIndex: -1,
        emit(type, data) {
            this.events.push({ type, data });
        },
        async _getPlaybackInfo(options) {
            this.infoRequests.push(options);
            return {
                PlaySessionId: `session-${options.itemId}-${this.infoRequests.length}`,
                MediaSources: [
                    {
                        Id: options.itemId,
                        Container: 'mkv',
                        RunTimeTicks: 72000000000,
                        MediaStreams: [],
                        SupportsDirectPlay: true
                    }
                ]
            };
        },
        _resolveForcedRemuxPlayMethod: (mediaSource, playMethod) => playMethod,
        isCurrentMediaHDR: () => false,
        _getBackendAudioTrackListIndex: () => 1,
        async setSubtitleStreamIndex() {},
        _armRemuxStuckWatchdog(ticks) {
            this.armedWatchdogs.push(ticks);
        },
        _clearRemuxStuckWatchdog() {}
    });
}

/** Play options as PlayerPage._startPlayback() builds them: it carries getPlaybackMode() over. */
function pageOptions(player, itemId, extra = {}) {
    const options = {
        itemId,
        userId: 'user',
        mediaSourceId: itemId,
        audioStreamIndex: 2,
        item: { Id: itemId, Chapters: [{}], MediaSources: [{ Id: itemId, Container: 'mkv', MediaStreams: [] }] },
        ...extra
    };
    const storedMode = player.getPlaybackMode();
    if (storedMode && storedMode !== 'auto') {
        options.playbackMode = storedMode;
    }
    return options;
}

async function waitFor(condition, what = 'condition') {
    for (let i = 0; i < 200 && !condition(); i++) {
        await flush();
    }
    assert.ok(condition(), `timed out waiting for ${what}`);
}

/** Start play() and let the backend load succeed as soon as it is requested. */
async function playAndStart(player, options) {
    const count = player.backend.loads.length;
    const result = player.play(options);
    await waitFor(() => player.backend.loads.length > count, 'the backend load');
    player.backend.loads[count].resolve();
    return result;
}

// ----------------------------------------------------------------------------
// HLS manifest polling
// ----------------------------------------------------------------------------

/** A fetch() that answers every request with the given HTTP status. */
function answeringFetch(status) {
    const requests = [];
    const fetch = async (url) => {
        requests.push(url);
        return { ok: status >= 200 && status < 300, status, text: async () => (status === 200 ? '#EXTM3U\n' : '') };
    };
    return { fetch, requests };
}

test('MediaHelper.pollHlsManifest: a client error ends polling at once instead of after 15 s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    for (const status of [400, 401, 403, 404]) {
        const server = answeringFetch(status);
        globalThis.fetch = server.fetch;
        try {
            let finished = false;
            MediaHelper.pollHlsManifest('http://srv/videos/x/master.m3u8').then(() => (finished = true));
            await flush();
            await flush();
            assert.ok(finished, `HTTP ${status}: still polling`);
            assert.strictEqual(server.requests.length, 1, `HTTP ${status}: asked again`);
        } finally {
            globalThis.fetch = realFetch;
        }
    }
});

test('MediaHelper.pollHlsManifest: server errors and "try again later" answers are retried within the budget', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    for (const status of [503, 429]) {
        const server = answeringFetch(status);
        globalThis.fetch = server.fetch;
        try {
            let finished = false;
            MediaHelper.pollHlsManifest('http://srv/videos/x/master.m3u8').then(() => (finished = true));
            await advance(t, 2000);
            assert.ok(!finished, `HTTP ${status}: polling gave up early`);
            assert.ok(server.requests.length >= 3, `HTTP ${status}: ${server.requests.length} requests`);

            await advance(t, 13500);
            assert.ok(finished, `HTTP ${status}: polling went past its 15 s budget`);
        } finally {
            globalThis.fetch = realFetch;
        }
    }
});

test('MediaHelper.pollHlsManifest: a ready manifest still ends polling (guard)', async () => {
    const server = answeringFetch(200);
    globalThis.fetch = server.fetch;
    try {
        await MediaHelper.pollHlsManifest('http://srv/videos/x/master.m3u8');
        assert.strictEqual(server.requests.length, 1);
    } finally {
        globalThis.fetch = realFetch;
    }
});

// ----------------------------------------------------------------------------
// Global bitrate limit
// ----------------------------------------------------------------------------

/** A JellyfinPlayer built by the real constructor (backend and subtitles stubbed). */
function constructPlayer(settings) {
    const context = vm.createContext(
        playerGlobals(settings, {
            EventEmitter: class {},
            SubtitleManager: class {}
        })
    );
    const JellyfinPlayer = vm.runInContext(
        `(class extends EventEmitter {\n${extractMethod('constructor(options) {')}\n${extractMethod('getMaxBitrate() {')}\n_initBackend() {}\n})`,
        context
    );
    return new JellyfinPlayer({ container: {} });
}

/** A stub player whose real _getPlaybackInfo() records the PlaybackInfo request bodies. */
function createPlaybackInfoPlayer(settings) {
    const bodies = [];
    const player = createPlayer({
        methods: ['async _getPlaybackInfo(options, deviceProfile, manualBitrate = null) {'],
        settings,
        globals: {
            buildJellyfinProfile: ({ manualBitrate }) => ({
                Name: 'stub',
                // The webOS, Tizen and web profiles fall back to the global limit
                MaxStreamingBitrate: manualBitrate || settings.maxBitrateInternet || 120000000,
                DirectPlayProfiles: [{}]
            }),
            MediaHelper: {
                getPlayMethod: () => 'DirectPlay',
                buildStreamUrl: ({ itemId }) => ({
                    url: itemId,
                    transcodingOffsetTicks: 0,
                    playerStartPositionTicks: 0
                }),
                fetchWithTimeout: async (url, init) => {
                    bodies.push(JSON.parse(init.body));
                    return {
                        response: { ok: true },
                        body: {
                            PlaySessionId: 'p',
                            MediaSources: [{ Id: 'x', MediaStreams: [], SupportsDirectPlay: true }]
                        }
                    };
                }
            }
        }
    });
    delete player._getPlaybackInfo; // the real one from the prototype
    return { player, bodies };
}

test('JellyfinPlayer: the global bitrate limit is not a quality picked in the OSD', () => {
    const player = constructPlayer({ maxBitrateInternet: 20000000 });
    assert.strictEqual(player._manualBitrate, null);
    assert.strictEqual(player.getMaxBitrate(), 0, 'the Quality menu shows Auto');
});

test('JellyfinPlayer: with a global bitrate limit, the first item is not forced to a transcode', async () => {
    const settings = { maxBitrateInternet: 20000000 };
    const { player, bodies } = createPlaybackInfoPlayer(settings);
    player._manualBitrate = constructPlayer(settings)._manualBitrate;

    await playAndStart(player, { itemId: 'A', userId: 'user', mediaSourceId: 'x' });
    await player.stop(); // next episode
    await playAndStart(player, { itemId: 'B', userId: 'user', mediaSourceId: 'x' });

    for (const [i, body] of bodies.entries()) {
        assert.strictEqual(body.EnableDirectPlay, true, `item ${i + 1}: direct play disabled`);
        assert.strictEqual(body.AllowVideoStreamCopy, undefined, `item ${i + 1}: video copy forbidden`);
        assert.strictEqual(body.MaxStreamingBitrate, 20000000, `item ${i + 1}: the limit was not sent`);
    }
    assert.strictEqual(bodies.length, 2);
});

test('JellyfinPlayer: a quality picked in the OSD still forces a transcode (guard)', async () => {
    const { player, bodies } = createPlaybackInfoPlayer({ maxBitrateInternet: 20000000 });
    player._manualBitrate = 4000000;

    await playAndStart(player, { itemId: 'A', userId: 'user', mediaSourceId: 'x' });
    assert.strictEqual(bodies[0].EnableDirectPlay, false);
    assert.strictEqual(bodies[0].AllowVideoStreamCopy, false);
    assert.strictEqual(bodies[0].MaxStreamingBitrate, 4000000);
});

// ----------------------------------------------------------------------------
// PlaybackInfo failures
// ----------------------------------------------------------------------------

/** A stub player with the real _getPlaybackInfo() and MediaHelper.fetchWithTimeout() on the given fetch(). */
function createFetchingPlayer(fetch) {
    const requests = [];
    const player = createPlayer({
        methods: ['async _getPlaybackInfo(options, deviceProfile, manualBitrate = null) {']
    });
    delete player._getPlaybackInfo;
    globalThis.fetch = (url, init) => {
        requests.push(JSON.parse(init.body));
        return fetch(url, init);
    };
    return { player, requests };
}

function restartsOf(player) {
    return player.events.filter((e) => e.type === 'restarting').length;
}

test('JellyfinPlayer: a PlaybackInfo request the server does not answer fails after one timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // The server accepts the connection, then stalls
    const { player, requests } = createFetchingPlayer(() => new Promise(() => {}));
    try {
        const outcome = player.play({ itemId: 'A', userId: 'user', mediaSourceId: 'A' }).then(
            () => null,
            (err) => err
        );
        // Long enough for a second request to time out as well
        await advance(t, 61000, 1000);
        const error = await Promise.race([outcome, flush().then(() => 'pending')]);
        assert.strictEqual(requests.length, 1, `asked again with EnableDirectPlay=${requests[1]?.EnableDirectPlay}`);
        assert.match(error?.message || '', /did not answer within 30 s/);
        assert.strictEqual(error.isNetworkError, true, 'the page does not see a lost connection');
        assert.strictEqual(restartsOf(player), 0);
        assert.strictEqual(player.events.filter((e) => e.type === 'error').length, 1);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('JellyfinPlayer: a PlaybackInfo server error or unreachable server is reported, not asked again', async () => {
    const answers = [
        [async () => ({ ok: false, status: 500, text: async () => 'boom' }), /500 - boom/, undefined],
        [() => Promise.reject(new TypeError('Failed to fetch')), /Failed to fetch/, true]
    ];
    for (const [fetch, message, isNetworkError] of answers) {
        const { player, requests } = createFetchingPlayer(fetch);
        try {
            const error = await player.play({ itemId: 'A', userId: 'user', mediaSourceId: 'A' }).then(
                () => null,
                (err) => err
            );
            assert.match(error?.message || '', message);
            assert.strictEqual(error.isNetworkError, isNetworkError);
            assert.strictEqual(requests.length, 1, 'asked for PlaybackInfo again');
            assert.strictEqual(restartsOf(player), 0);
        } finally {
            globalThis.fetch = realFetch;
        }
    }
});

test('JellyfinPlayer: a failed backend load is still escalated to a transcode (guard)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer();
    const playing = player.play({ itemId: 'A', userId: 'user', mediaSourceId: 'A' });
    await waitFor(() => player.backend.loads.length === 1, 'the backend load');
    player.backend.loads[0].reject(new Error('MEDIA_ERR_DECODE: pipeline rejected stream'));

    await waitFor(() => restartsOf(player) === 1, 'the escalation');
    await advance(t, 500);
    await waitFor(() => player.backend.loads.length === 2, 'the transcode load');
    assert.strictEqual(player.infoRequests[1].playbackMode, 'transcode');
    player.backend.loads[1].resolve();
    await playing;
});

// ----------------------------------------------------------------------------
// Playback Mode menu
// ----------------------------------------------------------------------------

/** Items whose selected audio track the stub reports as needing a server remux (e.g. DTS:X). */
const NEEDS_AUDIO_REMUX = new Set(['dtsx']);

function createModePlayer() {
    return createPlayer({
        methods: ['async setPlaybackMode(mode) {'],
        globals: { doesAudioTrackRequireDirectStream: (mediaSource) => NEEDS_AUDIO_REMUX.has(mediaSource.Id) }
    });
}

test('JellyfinPlayer: confirming the shown Auto on an item remuxed for its audio does not restart it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createModePlayer();
    await playAndStart(player, pageOptions(player, 'dtsx'));
    assert.strictEqual(player._playbackMode, 'remux', 'the item is remuxed for its audio');
    assert.strictEqual(player.getPlaybackMode(), 'auto', 'the menu shows Auto');

    const confirming = player.setPlaybackMode('auto');
    await advance(t, 1000);
    assert.strictEqual(player.events.filter((e) => e.type === 'restarting').length, 0);
    assert.strictEqual(player.backend.loads.length, 1, 'restarted into the same remux');
    await confirming;
});

test('JellyfinPlayer: picking another mode in the menu still restarts the item (guard)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createModePlayer();
    await playAndStart(player, pageOptions(player, 'dtsx'));

    const changing = player.setPlaybackMode('transcode');
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the restart');
    player.backend.loads[1].resolve();
    await changing;
    assert.strictEqual(player.infoRequests[1].playbackMode, 'transcode');
    assert.strictEqual(player.getPlaybackMode(), 'transcode');
});

// ----------------------------------------------------------------------------
// Automatic fallback modes
// ----------------------------------------------------------------------------

const FALLBACKS = [
    ['a failed native audio track switch', { type: 'audiotrackswitchfailed', data: { listIndex: 1 } }, 'remux'],
    ['a failed direct-play resume', { type: 'resumeseekfailed', data: { targetPositionTicks: 6000000000 } }, 'remux'],
    ['a direct-play error', { type: 'error', data: { code: 3, message: 'MEDIA_ERR_DECODE' } }, 'transcode']
];

for (const [name, event, fallbackMode] of FALLBACKS) {
    test(`JellyfinPlayer: the ${fallbackMode} after ${name} does not carry over to the next item`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const player = createPlayer();
        await playAndStart(player, pageOptions(player, 'A', { startPositionTicks: 6000000000 }));

        player._handleBackendEvent(event);
        await advance(t, 1000);
        await waitFor(() => player.backend.loads.length === 2, 'the restart');
        player.backend.loads[1].resolve();
        await waitFor(() => !player._isRestarting, 'the end of the restart');
        assert.strictEqual(player._playbackMode, fallbackMode, 'the item itself falls back');
        assert.strictEqual(player.getPlaybackMode(), 'auto', 'the Playback Mode menu shows the fallback as chosen');

        // PlayerPage: next episode
        await player.stop();
        await playAndStart(player, pageOptions(player, 'B'));
        assert.strictEqual(
            player.infoRequests[2].playbackMode,
            undefined,
            `the next item was forced to ${fallbackMode}`
        );
        assert.strictEqual(player._playbackMode, 'auto');
    });
}

/** Item A whose direct play failed with a decode error and was escalated to a transcode. */
async function escalateToTranscode(t, player) {
    await playAndStart(player, pageOptions(player, 'A'));
    player._handleBackendEvent({ type: 'error', data: { code: 3, message: 'MEDIA_ERR_DECODE' } });
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the transcode');
    player.backend.loads[1].resolve();
    await waitFor(() => !player._isRestarting, 'the end of the restart');
    assert.strictEqual(player.infoRequests[1].playbackMode, 'transcode');
}

test('JellyfinPlayer: Retry or network recovery of the same item keeps its automatic transcode', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer();
    await escalateToTranscode(t, player);

    // PlayerPage._startAutoRecovery() stops the player, _finishAutoRecovery() starts the item again
    await player.stop();
    await playAndStart(player, pageOptions(player, 'A', { startPositionTicks: 36000000000 }));
    assert.strictEqual(
        player.infoRequests[2].playbackMode,
        'transcode',
        'recovery went back to the failed direct play'
    );

    // PlayerPage._retryPlayback() starts the item again without stop()
    await playAndStart(player, pageOptions(player, 'A', { startPositionTicks: 36000000000 }));
    assert.strictEqual(player.infoRequests[3].playbackMode, 'transcode', 'Retry went back to the failed direct play');
    assert.strictEqual(player.getPlaybackMode(), 'auto');
});

test('JellyfinPlayer: the fallback of an item ends with another item or a mode picked by the user (guard)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let player = createModePlayer();
    await escalateToTranscode(t, player);
    await player.stop();
    await playAndStart(player, pageOptions(player, 'B'));
    await player.stop();
    await playAndStart(player, pageOptions(player, 'A'));
    assert.strictEqual(player.infoRequests[3].playbackMode, undefined, 'A started in its old fallback after B');

    // The error screen's Playback Mode button: the user picks Direct Play, then Retry
    player = createModePlayer();
    await escalateToTranscode(t, player);
    await player.stop();
    await player.setPlaybackMode('directPlay');
    await playAndStart(player, pageOptions(player, 'A'));
    assert.strictEqual(player.infoRequests[2].playbackMode, 'directPlay');
});

test('JellyfinPlayer: a mode picked in the menu carries over, also after a fallback restart', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createModePlayer();
    await player.setPlaybackMode('remux');
    await playAndStart(player, pageOptions(player, 'A', { startPositionTicks: 6000000000 }));

    // The remux fails to resume: a transcode for this item
    player._currentPlayMethod = 'Remux';
    player._handleBackendEvent({ type: 'resumeseekfailed', data: { targetPositionTicks: 6000000000 } });
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the restart');
    player.backend.loads[1].resolve();
    await waitFor(() => !player._isRestarting, 'the end of the restart');
    assert.strictEqual(player._playbackMode, 'transcode');

    await player.stop();
    await playAndStart(player, pageOptions(player, 'B'));
    assert.strictEqual(player.infoRequests[2].playbackMode, 'remux');
});

test('JellyfinPlayer: an audio track switch restarts in the mode picked in the menu', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer({
        methods: ['async setPlaybackMode(mode) {', 'async setAudioStreamIndex(index) {'],
        globals: { prewarmManager: { invalidateCache() {} } }
    });
    player.getAudioTracks = () => [
        { Index: 1, Type: 'Audio', Codec: 'aac' },
        { Index: 2, Type: 'Audio', Codec: 'ac3' }
    ];
    await playAndStart(player, pageOptions(player, 'A'));

    const picking = player.setPlaybackMode('remux');
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the remux restart');
    player.backend.loads[1].resolve();
    await picking;

    // The server copies the streams of the remux; a track switch needs a restart
    player._currentPlayMethod = 'Remux';
    const switching = player.setAudioStreamIndex(1);
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 3, 'the track switch restart');
    player.backend.loads[2].resolve();
    await switching;
    assert.strictEqual(player.infoRequests[2].playbackMode, 'remux', 'the picked remux was dropped');
    assert.strictEqual(player.getPlaybackMode(), 'remux');
});

// ----------------------------------------------------------------------------
// Back / Next while a restart loads
// ----------------------------------------------------------------------------

const WATCHDOG_METHODS = [
    '_armRemuxStuckWatchdog(targetTicks) {',
    '_scheduleRemuxWatchdogCheck(delayMs) {',
    '_getBackendBufferState() {',
    '_clearRemuxStuckWatchdog() {',
    '_handleRemuxWatchdogTimeout() {'
];

/**
 * Item A plays as a remux resumed at 1 h (remux watchdog armed) at 1.5x; the
 * user lowers the quality and the restart's PlaybackInfo is slow.
 * Returns once that restart is loading, with `release()` to answer it.
 */
async function startSlowQualityRestart(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer({ methods: ['async setMaxBitrate(bitrate) {', ...WATCHDOG_METHODS] });
    delete player._armRemuxStuckWatchdog;
    delete player._clearRemuxStuckWatchdog;

    await playAndStart(player, pageOptions(player, 'A', { playbackMode: 'remux', startPositionTicks: 36000000000 }));
    assert.ok(player._remuxWatchdogActive, 'watchdog armed for A');
    player._playbackSpeed = 1.5;

    let release;
    const answer = player._getPlaybackInfo.bind(player);
    player._getPlaybackInfo = async function (options) {
        if (options.itemId === 'A') {
            await new Promise((resolve) => (release = resolve));
        }
        return answer(options);
    };
    const restart = player.setMaxBitrate(4000000);
    await advance(t, 1000);
    await waitFor(() => typeof release === 'function', 'the restart PlaybackInfo');
    return { player, restart, release: () => release() };
}

test('JellyfinPlayer: Next while a quality restart loads does not hand the restart over to the next item', async (t) => {
    const { player, restart, release } = await startSlowQualityRestart(t);

    // PlayerPage._playNextItem(): stop(), then the next item
    player.events.length = 0;
    await player.stop();
    const stopEvents = player.events.filter((e) => e.type === 'stop' || e.type === 'playbackstop').length;
    await playAndStart(player, pageOptions(player, 'B'));
    release();
    await restart;
    // Long past the first check of A's remux watchdog
    await advance(t, 10000, 1000);

    const problems = [];
    if (stopEvents !== 2) problems.push(`Next sent ${stopEvents} of STOP and PLAYBACK_STOP`);
    if (player.profiles[player.profiles.length - 1].manualBitrate !== null) {
        problems.push("B was built with A's 4 Mbps quality");
    }
    if (player.backend.speeds.includes(1.5)) problems.push("B was set to A's 1.5x speed");
    if (player.backend.loads.length !== 2) {
        const load = player.backend.loads[2].options;
        problems.push(`A's remux watchdog restarted B at A's position ${load.startPositionTicks}`);
    }
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(player._isRestarting, false);
    assert.strictEqual(player.getMaxBitrate(), 0);
});

test('JellyfinPlayer: after Back from a loading restart, the next item is a fresh start that can escalate', async (t) => {
    const { player, restart, release } = await startSlowQualityRestart(t);
    await player.stop();
    assert.strictEqual(player._isRestarting, false, 'the restart still runs after Back');

    // The next item's direct play fails while the abandoned restart still waits for its PlaybackInfo
    const playing = player.play(pageOptions(player, 'B'));
    await waitFor(() => player.backend.loads.length === 2, 'the load of B');
    player.backend.loads[1].reject(new Error('MEDIA_ERR_DECODE: pipeline rejected stream'));
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 3, 'the transcode of B');
    assert.strictEqual(player.backend.loads[2].options.item.Id, 'B');
    assert.strictEqual(player.infoRequests[player.infoRequests.length - 1].playbackMode, 'transcode');
    player.backend.loads[2].resolve();
    await playing;

    release();
    await restart;
    assert.strictEqual(player.backend.loads.length, 3, 'the abandoned restart loaded A');
});

test("JellyfinPlayer: Back while a restart's own stop() waits for an asynchronous backend ends the restart", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer({ methods: ['async setMaxBitrate(bitrate) {'] });
    await playAndStart(player, pageOptions(player, 'A'));
    // ExoVideoPlayer and TizenAVPlayer: stop() resolves only after the native player stopped
    const stopBackend = player.backend.stop.bind(player.backend);
    player.backend.stop = async () => {
        await stopBackend();
        await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const quality = player.setMaxBitrate(4000000);
    await flush();
    const back = player.stop();
    await advance(t, 2000, 50);
    await back;
    assert.strictEqual(player.backend.loads.length, 1, 'the restart loaded A again after Back');
    assert.strictEqual(player.infoRequests.length, 1);
    await quality;
    assert.strictEqual(player._isRestarting, false);
});

test("JellyfinPlayer: an abandoned restart of the previous item leaves the next item's restart running", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer({ methods: ['async setMaxBitrate(bitrate) {'] });
    await playAndStart(player, pageOptions(player, 'A'));

    // A's quality restart waits for a slow PlaybackInfo
    let releaseA;
    const answer = player._getPlaybackInfo.bind(player);
    player._getPlaybackInfo = async function (options) {
        if (options.itemId === 'A') {
            await new Promise((resolve) => (releaseA = resolve));
        }
        return answer(options);
    };
    const restartA = player.setMaxBitrate(4000000);
    await advance(t, 1000);
    await waitFor(() => typeof releaseA === 'function', "A's restart PlaybackInfo");

    // Next, then a quality change on B while A's restart still waits
    await player.stop();
    await playAndStart(player, pageOptions(player, 'B'));
    const restartB = player.setMaxBitrate(2000000);
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 3, "B's restart load");

    releaseA();
    await restartA;
    assert.strictEqual(player._isRestarting, true, "A's restart flow cleared the flag of B's restart");
    player.backend.loads[2].resolve();
    await restartB;
    assert.strictEqual(player._isRestarting, false);
});

test('JellyfinPlayer: a restart keeps the quality and speed of its item (guard)', async (t) => {
    const { player, restart, release } = await startSlowQualityRestart(t);
    release();
    await waitFor(() => player.backend.loads.length === 2, 'the restart load');
    player.backend.loads[1].resolve();
    await restart;

    assert.strictEqual(player.events.filter((e) => e.type === 'stop').length, 0);
    assert.strictEqual(player.profiles[player.profiles.length - 1].manualBitrate, 4000000);
    assert.deepStrictEqual(player.backend.speeds, [1.5]);
    assert.strictEqual(player._isRestarting, false);
});

// ----------------------------------------------------------------------------
// play()'s result
// ----------------------------------------------------------------------------

/** play() of item A whose direct-play load fails, so play() escalates to a transcode itself. */
async function playWithFailingLoad(t, player) {
    const playing = player.play(pageOptions(player, 'A'));
    await waitFor(() => player.backend.loads.length === 1, 'the load');
    player.backend.loads[0].reject(new Error('MEDIA_ERR_DECODE: pipeline rejected stream'));
    await advance(t, 1000);
    return playing;
}

test("JellyfinPlayer: Back while play()'s own escalation loads makes play() resolve false", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer();
    const answer = player._getPlaybackInfo.bind(player);
    player._getPlaybackInfo = async function (options) {
        if (this.infoRequests.length === 1) {
            // The user presses Back while the transcode's PlaybackInfo loads
            await player.stop();
        }
        return answer(options);
    };

    const result = await playWithFailingLoad(t, player);
    assert.strictEqual(player.infoRequests[1].playbackMode, 'transcode', 'escalated to a transcode');
    assert.strictEqual(
        result,
        false,
        `play() resolved ${result}: PlayerPage reports a start for an item the user left`
    );
});

test('JellyfinPlayer: play() resolves true when its own escalation starts playback', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer();
    const playing = playWithFailingLoad(t, player);
    await waitFor(() => player.backend.loads.length === 2, 'the transcode load');
    player.backend.loads[1].resolve();
    assert.strictEqual(await playing, true);
});

test('JellyfinPlayer: play() resolves true once playback started', async () => {
    const player = createPlayer();
    assert.strictEqual(await playAndStart(player, pageOptions(player, 'A')), true);
});

// ----------------------------------------------------------------------------
// A restart during the page's play()
// ----------------------------------------------------------------------------

/**
 * PlayerPage's play() of item A, its load still pending (webOS resolves
 * video.play() only once playback starts).
 */
async function startPagePlay(player) {
    const playing = player.play(pageOptions(player, 'A'));
    let settled = false;
    playing.then(
        () => (settled = true),
        () => (settled = true)
    );
    await waitFor(() => player.backend.loads.length === 1, 'the load of A');
    return { playing, isSettled: () => settled };
}

const audioTrackSwitchFailed = { type: 'audiotrackswitchfailed', data: { listIndex: 1 } };
const decodeError = { type: 'error', data: { code: 3, message: 'MEDIA_ERR_DECODE' } };

test("JellyfinPlayer: a failed audio track switch while the page's play() loads resolves it with the restart", async () => {
    const player = createPlayer();
    const page = await startPagePlay(player);

    // WebOSPlayer: audioTracks empty and the wanted track is not the default one
    player._handleBackendEvent(audioTrackSwitchFailed);
    await waitFor(() => player.backend.loads.length === 2, 'the remux restart');
    await flush();
    assert.ok(!page.isSettled(), 'play() settled before the restart did');
    player.backend.loads[1].resolve();

    const result = await page.playing;
    assert.strictEqual(result, true, `play() resolved ${result}: PlayerPage skips _initOSD()`);
    assert.ok(player._isPlaying);
    assert.strictEqual(player.events.filter((e) => e.type === 'playbackstart').length, 1);
});

test("JellyfinPlayer: a decode error while the page's play() loads resolves it with the transcode", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer();
    const page = await startPagePlay(player);

    player._handleBackendEvent(decodeError);
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the transcode');
    assert.strictEqual(player.infoRequests[1].playbackMode, 'transcode');
    player.backend.loads[1].resolve();
    assert.strictEqual(await page.playing, true);
});

test("JellyfinPlayer: Back during a restart that replaced the page's play() resolves that play() false (guard)", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Back while the restart loads
    let player = createPlayer();
    let page = await startPagePlay(player);
    player._handleBackendEvent(audioTrackSwitchFailed);
    await waitFor(() => player.backend.loads.length === 2, 'the remux restart');
    await player.stop();
    assert.strictEqual(await page.playing, false, 'Back while the restart loaded');

    // Back during the pause before the restart's play()
    player = createPlayer();
    page = await startPagePlay(player);
    player._handleBackendEvent(decodeError);
    await flush();
    await player.stop();
    assert.strictEqual(await page.playing, false, 'Back before the restart loaded');
    await advance(t, 1000);
    assert.strictEqual(player.backend.loads.length, 1, 'the abandoned restart loaded A');
    assert.strictEqual(player.events.filter((e) => e.type === 'playbackstart').length, 0);
});

test("JellyfinPlayer: a newer play() during a restart that replaced the page's play() resolves that play() false (guard)", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer();
    const page = await startPagePlay(player);
    player._handleBackendEvent(decodeError);
    await flush();

    const next = player.play(pageOptions(player, 'B'));
    assert.strictEqual(await page.playing, false);
    await waitFor(() => player.backend.loads.length === 2, 'the load of B');
    player.backend.loads[1].resolve();
    assert.strictEqual(await next, true);
    await advance(t, 1000);
    assert.strictEqual(player.backend.loads.length, 2, 'the abandoned restart loaded A');
});

test("JellyfinPlayer: a restart that fails rejects the page's play() it replaced, reported once", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer();
    const answer = player._getPlaybackInfo.bind(player);
    player._getPlaybackInfo = async function (options) {
        if (this.infoRequests.length === 1) {
            throw new Error('Failed to get playback info: 500 - boom');
        }
        return answer(options);
    };
    const page = await startPagePlay(player);
    player._handleBackendEvent(decodeError);
    await advance(t, 1000);

    await assert.rejects(page.playing, /500 - boom/);
    assert.strictEqual(player.events.filter((e) => e.type === 'error').length, 1);
});

test('JellyfinPlayer: a resume remux replaced by an audio track restart arms no watchdog on the new session', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer({
        methods: ['async setAudioStreamIndex(index) {'],
        globals: { prewarmManager: { invalidateCache() {} } }
    });
    player.getAudioTracks = () => [
        { Index: 1, Type: 'Audio', Codec: 'aac' },
        { Index: 2, Type: 'Audio', Codec: 'ac3' }
    ];
    await playAndStart(player, pageOptions(player, 'A', { startPositionTicks: 36000000000 }));

    // The direct-play resume fails: a remux restart at the resume point
    player._handleBackendEvent({ type: 'resumeseekfailed', data: { targetPositionTicks: 36000000000 } });
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the remux restart');
    player._currentPlayMethod = 'Remux';

    // The user switches the audio track while the remux loads
    const switching = player.setAudioStreamIndex(1);
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 3, 'the audio track restart');
    player.backend.loads[2].resolve();
    await switching;
    await flush();
    assert.deepStrictEqual(player.armedWatchdogs, [], "the remux's watchdog was armed on the audio restart's session");
});

test("JellyfinPlayer: restarts that replace each other during the page's play() resolve it with the last one", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const methods = ['async setMaxBitrate(bitrate) {'];

    // The second restart comes while the first one loads
    let player = createPlayer({ methods });
    let page = await startPagePlay(player);
    player._handleBackendEvent(audioTrackSwitchFailed);
    await waitFor(() => player.backend.loads.length === 2, 'the remux restart');
    let quality = player.setMaxBitrate(4000000);
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 3, 'the quality restart');
    await flush();
    assert.ok(!page.isSettled(), 'play() settled with the replaced restart');
    player.backend.loads[2].resolve();
    assert.strictEqual(await page.playing, true, 'the second restart came while the first one loaded');
    await quality;

    // The second restart comes before the first one plays
    player = createPlayer({ methods });
    page = await startPagePlay(player);
    player._handleBackendEvent(decodeError);
    await flush();
    quality = player.setMaxBitrate(4000000);
    await advance(t, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the quality restart');
    await flush();
    assert.ok(!page.isSettled(), 'play() settled with the replaced restart');
    player.backend.loads[1].resolve();
    assert.strictEqual(await page.playing, true, 'the second restart came before the first one played');
    await quality;
    assert.strictEqual(player.backend.loads.length, 2, 'the replaced transcode restart loaded as well');
});

// ----------------------------------------------------------------------------
// Stuck seeks in a transcode
// ----------------------------------------------------------------------------

const SEEK_TARGET = 36000000000;
const seekStuck = { type: 'seekstuck', data: { targetPositionTicks: SEEK_TARGET } };

/** Item A playing with the given play method; the test controls time (setTimeout and Date). */
async function startSeekingPlayer(t, playMethod) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const player = createPlayer({ methods: ['seek(positionTicks, options = {}) {'] });
    await playAndStart(player, pageOptions(player, 'A'));
    player._currentPlayMethod = playMethod;
    // The element seeks until a test lets the seek land
    player.backend.video = { seeking: true };
    player.events.length = 0;
    return player;
}

function reloadsOf(player) {
    return player.backend.loads.slice(1).map((load) => load.options.startPositionTicks);
}

test('JellyfinPlayer: a transcode seek reported stuck after 8 s is reloaded only if still pending at 30 s', async (t) => {
    const player = await startSeekingPlayer(t, 'Transcode');
    player.seek(SEEK_TARGET);

    // WebOSPlayer: 8 s of playback without new data while the server restarts FFmpeg
    await advance(t, 8000, 1000);
    player._handleBackendEvent(seekStuck);
    await advance(t, 21000, 1000);
    assert.deepStrictEqual(reloadsOf(player), [], 'reloaded a transcode seek that was still loading');
    assert.ok(!player.events.some((e) => e.type === 'restarting'));

    await advance(t, 2000, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the reload');
    assert.deepStrictEqual(reloadsOf(player), [SEEK_TARGET]);
});

test('JellyfinPlayer: a transcode seek that lands after the stuck report is not reloaded', async (t) => {
    for (const landing of ['seeked', 'playing']) {
        const player = await startSeekingPlayer(t, 'Transcode');
        player.seek(SEEK_TARGET);
        await advance(t, 8000, 1000);
        player._handleBackendEvent(seekStuck);
        await advance(t, 6000, 1000);
        player._handleBackendEvent({ type: landing });

        await advance(t, 30000, 1000);
        assert.deepStrictEqual(reloadsOf(player), [], `reloaded after '${landing}'`);
        t.mock.timers.reset();
    }
});

test('JellyfinPlayer: a new seek restarts the wait of a stuck transcode seek', async (t) => {
    const player = await startSeekingPlayer(t, 'Transcode');
    player.seek(SEEK_TARGET);
    await advance(t, 8000, 1000);
    player._handleBackendEvent(seekStuck);
    await advance(t, 4000, 1000);
    // Back to the pending target (e.g. +10 s, then -10 s): WebOSPlayer skips a seek that
    // close to the element's position, so no new 'seeking' and no new stuck report
    player.seek(SEEK_TARGET);

    await advance(t, 29000, 1000);
    assert.deepStrictEqual(reloadsOf(player), [], 'reloaded before 30 s from the last seek');
    await advance(t, 2000, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the reload (the wait was dropped)');
    assert.deepStrictEqual(reloadsOf(player), [SEEK_TARGET]);
});

test('JellyfinPlayer: a stuck transcode seek is not reloaded while paused, and gets 30 s from Play', async (t) => {
    const player = await startSeekingPlayer(t, 'Transcode');
    player.seek(SEEK_TARGET);
    await advance(t, 8000, 1000);
    player._handleBackendEvent(seekStuck);
    await advance(t, 4000, 1000);
    player._handleBackendEvent({ type: 'pause' });

    await advance(t, 60000, 1000);
    assert.deepStrictEqual(reloadsOf(player), [], 'reloaded (and resumed) while paused');

    // The element resumes: the backend reports 'play'
    player._handleBackendEvent({ type: 'play' });
    await advance(t, 29000, 1000);
    assert.deepStrictEqual(reloadsOf(player), [], 'reloaded before 30 s from Play');
    await advance(t, 2000, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the reload');
    assert.deepStrictEqual(reloadsOf(player), [SEEK_TARGET]);
});

test('JellyfinPlayer: a paused seek gets its 30 s from Play, when webOS carries it out', async (t) => {
    const player = await startSeekingPlayer(t, 'Transcode');
    player._handleBackendEvent({ type: 'pause' });
    player.seek(SEEK_TARGET);
    await advance(t, 25000, 1000);

    // Play; the seek is still pending and stalls for 8 s
    // The element resumes: the backend reports 'play'
    player._handleBackendEvent({ type: 'play' });
    await advance(t, 8000, 1000);
    player._handleBackendEvent(seekStuck);
    await advance(t, 21000, 1000);
    assert.deepStrictEqual(reloadsOf(player), [], 'the paused time counted for the seek');
    await advance(t, 2000, 1000);
    await waitFor(() => player.backend.loads.length === 2, 'the reload');
});

test('JellyfinPlayer: a stuck transcode seek that has landed by the deadline is not reloaded', async (t) => {
    const player = await startSeekingPlayer(t, 'Transcode');
    player.seek(SEEK_TARGET);
    await advance(t, 8000, 1000);
    player._handleBackendEvent(seekStuck);
    await advance(t, 10000, 1000);
    // The element finished the seek, but no 'seeked' or 'playing' reached the player
    player.backend.video.seeking = false;

    await advance(t, 20000, 1000);
    assert.deepStrictEqual(reloadsOf(player), []);
});

test('JellyfinPlayer: a stuck seek outside a transcode is still reloaded at once (guard)', async (t) => {
    for (const playMethod of ['Remux', 'DirectStream', 'DirectPlay']) {
        const player = await startSeekingPlayer(t, playMethod);
        player.seek(SEEK_TARGET);
        await advance(t, 8000, 1000);
        player._handleBackendEvent(seekStuck);
        await waitFor(() => player.backend.loads.length === 2, `the reload of a ${playMethod} seek`);
        assert.deepStrictEqual(reloadsOf(player), [SEEK_TARGET]);
        t.mock.timers.reset();
    }
});

// ----------------------------------------------------------------------------
// A spot the server never delivers
// ----------------------------------------------------------------------------

/**
 * Item A playing as a transcode, its element seeking at SEEK_TARGET for good
 * (as past the end of a file's picture on an LG C4), and past the 30 s a
 * transcode seek gets, so each stuck report is acted on at once.
 */
async function startUndeliverableSpot(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const player = createPlayer({
        methods: ['seek(positionTicks, options = {}) {'],
        globals: {
            MediaHelper: {
                getPlayMethod: () => 'Transcode',
                buildStreamUrl: ({ itemId, startPositionTicks }) => ({
                    url: `http://srv/${itemId}`,
                    transcodingOffsetTicks: 0,
                    playerStartPositionTicks: startPositionTicks
                }),
                fetchWithTimeout: MediaHelper.fetchWithTimeout
            }
        }
    });
    await playAndStart(player, pageOptions(player, 'A', { playbackMode: 'transcode' }));
    player.backend.video = { seeking: true };
    player.seek(SEEK_TARGET);
    await advance(t, 31000, 1000);
    player.events.length = 0;
    return player;
}

/** Report the seek stuck, and let a reload or restart it causes load. */
async function reportStuck(t, player) {
    const count = player.backend.loads.length;
    player._handleBackendEvent(seekStuck);
    await advance(t, 2000, 250);
    if (player.backend.loads.length > count) {
        player.backend.loads[count].resolve();
        await flush();
    }
}

test('JellyfinPlayer: a spot that never plays gets one reload and one transcode retry, then the error', async (t) => {
    const player = await startUndeliverableSpot(t);

    await reportStuck(t, player);
    assert.strictEqual(player.backend.loads.length, 2, 'the stuck seek was not reloaded');
    await reportStuck(t, player);
    assert.strictEqual(player.backend.loads.length, 3, 'the stuck reload was not escalated to a transcode retry');
    assert.ok(!player.events.some((e) => e.type === 'error'), 'gave up before the transcode retry');

    // The retry is stuck at the same spot too, and keeps being reported
    for (let i = 0; i < 4; i++) {
        await reportStuck(t, player);
    }
    assert.strictEqual(player.backend.loads.length, 3, 'the transcode retry was reloaded and restarted again');
    const errors = player.events.filter((e) => e.type === 'error');
    assert.strictEqual(errors.length, 1, 'no error, or more than one');
    assert.strictEqual(errors[0].data.code, 'SEEK_STUCK');
    assert.ok(
        !/network|connection|offline/i.test(errors[0].data.message),
        'the page would take it for a network error'
    );
});

test('JellyfinPlayer: a transcode retry that plays leaves a later stuck seek its own reload and retry (guard)', async (t) => {
    const player = await startUndeliverableSpot(t);
    await reportStuck(t, player);
    await reportStuck(t, player);
    assert.strictEqual(player.backend.loads.length, 3);

    // The retry lands at the target and plays on
    const targetSec = SEEK_TARGET / 10000000;
    player.backend.video.seeking = false;
    player._handleBackendEvent({ type: 'timeupdate', data: { time: targetSec } });
    player._handleBackendEvent({ type: 'timeupdate', data: { time: targetSec + 1 } });

    // Much later, a seek elsewhere gets stuck
    player.backend.video.seeking = true;
    player.seek(SEEK_TARGET * 2);
    await advance(t, 31000, 1000);
    await reportStuck(t, player);
    assert.strictEqual(player.backend.loads.length, 4, 'the later stuck seek was not reloaded');
    await reportStuck(t, player);
    assert.strictEqual(player.backend.loads.length, 5, 'the later stuck reload got no transcode retry');
    assert.ok(!player.events.some((e) => e.type === 'error'), 'ended with an error before its own retry');
});
