/* eslint-env node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Player Controller Follow-up Test Suite: webOS restart during startup
 * ============================================================================
 * On webOS, a restart can start while the page's first play() is still
 * pending: WebOSPlayer reports a failed audio track switch (direct-play MKV,
 * empty audioTracks, preferred track not the file's default) or a decode
 * error before video.play() resolves. The restart's stop() supersedes that
 * load. play() must still resolve with the restart: PlayerPage skips its OSD
 * setup (controls, media keys, plugins) when play() resolves false.
 * The real WebOSPlayer runs on a minimal DOM; the JellyfinPlayer methods
 * under test are taken from the source and run on a stub player.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Minimal DOM: <video>/<source> stand-ins that can fire events
// ----------------------------------------------------------------------------

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

/** Chromium resolves video.play() only once playback starts */
const PLAY_DELAY_MS = 20;

function createVideo() {
    return createEventTarget({
        tagName: 'VIDEO',
        children: [],
        style: {},
        parentNode: null,
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        muted: false,
        paused: true,
        seeking: false,
        videoWidth: 1920,
        videoHeight: 1080,
        volume: 1,
        seekable: { length: 1 },
        buffered: { length: 0 },
        error: null,
        src: '',
        get firstChild() {
            return this.children[0] || null;
        },
        setAttribute() {},
        removeAttribute(name) {
            if (name === 'src') this.src = '';
        },
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
        },
        removeChild(child) {
            child.parentNode = null;
            this.children = this.children.filter((c) => c !== child);
        },
        load() {},
        pause() {
            this.paused = true;
        },
        play() {
            this.paused = false;
            return new Promise((resolve) => setTimeout(resolve, PLAY_DELAY_MS));
        },
        canPlayType: () => ''
    });
}

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = Object.assign(createEventTarget({}), {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement(tag) {
        if (tag === 'video') return createVideo();
        if (tag === 'source') return createEventTarget({ tagName: 'SOURCE', src: '', type: '' });
        return {
            classList: { add() {}, remove() {}, toggle() {} },
            style: {},
            addEventListener() {},
            querySelectorAll: () => [],
            appendChild() {},
            canPlayType: () => '',
            innerHTML: ''
        };
    }
});
globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U\n' });

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----------------------------------------------------------------------------
// JellyfinPlayer methods on a stub player, with the real WebOSPlayer as backend
// ----------------------------------------------------------------------------

const source = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
);

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

const METHODS = [
    'async play(options) {',
    'async stop(options = {}) {',
    '_handleBackendEvent(event) {',
    'getPlaybackMode() {',
    '_abandonSupersededPlay(stage) {',
    'async _playAfterRestartPause(options, pauseMs) {',
    '_clearResumeAdvanceWait() {',
    '_isAwaitingResumeAdvance(time) {',
    '_finishResumeWait(message) {',
    'getCurrentPositionTicks() {'
];

// MKV whose container default is English AAC; the user's preferred track is the Japanese AC-3
const mkvTwoAudio = {
    Container: 'mkv',
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2, IsDefault: true },
        { Index: 2, Type: 'Audio', Codec: 'ac3', Language: 'jpn', Channels: 6, IsDefault: false }
    ]
};

function createPlayer() {
    const context = vm.createContext({
        setTimeout,
        clearTimeout,
        Promise,
        Object,
        Number,
        Date,
        Math,
        log: { info() {}, debug() {}, warn() {}, error() {} },
        PlayerSettings: { get: () => undefined },
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
        MediaHelper: {
            getPlayMethod: () => 'DirectPlay',
            buildStreamUrl: ({ itemId, startPositionTicks }) => ({
                url: `http://srv/Videos/${itemId}/stream.mkv?Static=true`,
                transcodingOffsetTicks: 0,
                playerStartPositionTicks: startPositionTicks
            })
        },
        api: { getItem: async () => ({}) }
    });
    const methods = vm.runInContext(`${playerEventSource}\n({\n${METHODS.map(extractMethod).join(',\n')}\n})`, context);
    const player = Object.assign(Object.create(methods), {
        events: [],
        infoRequests: [],
        _playRequestId: 0,
        _isRestarting: false,
        _audioRestartInProgress: false,
        _directPlayEscalated: false,
        _isSeeking: false,
        _seekTargetTicks: null,
        _pendingStartPositionTicks: null,
        _transcodingOffsetTicks: 0,
        _remuxWatchdogActive: false,
        _manualBitrate: null,
        _backendType: 'webos',
        _subtitleManager: { setMediaContext() {}, tick() {}, play() {}, pause() {}, resetActiveCues() {} },
        _currentPlayMethod: null,
        _playbackMode: 'auto',
        _userPlaybackMode: 'auto',
        _currentSecondarySubtitleStreamIndex: -1,
        emit(type) {
            this.events.push(type);
        },
        async _getPlaybackInfo(options) {
            this.infoRequests.push(options);
            return { PlaySessionId: 'session', MediaSources: [{ ...mkvTwoAudio, Id: options.itemId }] };
        },
        _resolveForcedRemuxPlayMethod: (mediaSource, playMethod) => playMethod,
        isCurrentMediaHDR: () => false,
        // The webOS list index of the requested track (the Japanese one is the second)
        _getBackendAudioTrackListIndex: (streamIndex) => (streamIndex === 2 ? 1 : 0),
        async setSubtitleStreamIndex() {},
        _armRemuxStuckWatchdog() {},
        _clearRemuxStuckWatchdog() {}
    });
    player._backend = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: (event) => player._handleBackendEvent(event)
    });
    return player;
}

/** PlayerPage._startPlayback(): play() of item A, up to the load's 'canplay'. */
async function startPagePlay(player, audioStreamIndex) {
    const playing = player.play({
        itemId: 'A',
        mediaSourceId: 'A',
        audioStreamIndex,
        item: { Id: 'A', Chapters: [{}], MediaSources: [{ ...mkvTwoAudio, Id: 'A' }] }
    });
    let result = 'pending';
    playing.then(
        (value) => (result = value),
        (error) => (result = error)
    );
    for (let i = 0; i < 5; i++) await flush();
    player._backend._videoElement.fire('canplay');
    return { playing, result: () => result };
}

/** Let the restart's load reach 'canplay' once it has started. */
async function startRestartLoad(player, loadsBefore) {
    for (let i = 0; i < 100 && player.infoRequests.length === loadsBefore; i++) await sleep(10);
    assert.strictEqual(player.infoRequests.length, loadsBefore + 1, 'the restart did not load');
    for (let i = 0; i < 5; i++) await flush();
    player._backend._videoElement.fire('canplay');
    await sleep(PLAY_DELAY_MS * 3);
}

test("JellyfinPlayer + WebOSPlayer: a remux restart reported while the page's play() loads resolves that play() true", async () => {
    const player = createPlayer();
    // The file's default track: WebOSPlayer itself reports no track problem
    const page = await startPagePlay(player, 1);

    // A failed audio track switch reported while video.play() is still pending
    // (on webOS: a direct-play MKV whose preferred track is not the default)
    player._handleBackendEvent({ type: 'audiotrackswitchfailed', data: { listIndex: 0 } });
    await flush();
    assert.ok(player.events.includes('restarting'), 'no restart for the failed track switch');
    assert.strictEqual(page.result(), 'pending', 'play() settled before the restart did');

    await startRestartLoad(player, 1);
    assert.strictEqual(player.infoRequests[1].playbackMode, 'remux');
    assert.strictEqual(page.result(), true, `play() resolved ${page.result()}: PlayerPage skips _initOSD()`);
    assert.strictEqual(player.events.filter((e) => e === 'playbackstart').length, 1);
});

test("JellyfinPlayer + WebOSPlayer: a decode error before playback starts resolves the page's play() with the transcode", async () => {
    const player = createPlayer();
    const page = await startPagePlay(player, 1);

    // The pipeline fails between 'canplay' and 'playing'
    const video = player._backend._videoElement;
    video.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' };
    video.fire('error');
    await flush();
    assert.ok(player.events.includes('restarting'), 'the decode error was not escalated');
    video.error = null;

    await startRestartLoad(player, 1);
    assert.strictEqual(player.infoRequests[1].playbackMode, 'transcode');
    assert.strictEqual(page.result(), true, `play() resolved ${page.result()}: PlayerPage skips _initOSD()`);
});

test("JellyfinPlayer + WebOSPlayer: Back during the startup restart resolves the page's play() false (guard)", async () => {
    const player = createPlayer();
    const page = await startPagePlay(player, 1);
    player._handleBackendEvent({ type: 'audiotrackswitchfailed', data: { listIndex: 0 } });
    await flush();
    assert.ok(player.events.includes('restarting'));
    assert.strictEqual(page.result(), 'pending');

    await player.stop();
    assert.strictEqual(await page.playing, false);
});
