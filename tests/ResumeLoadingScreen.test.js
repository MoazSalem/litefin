import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Resume Loading Screen Test Suite
 * ============================================================================
 * A <video> backend (webOS, HTML5) reports the resume position as soon as
 * the seek lands, before any frame is decoded. The loading screen was
 * dismissed right then: on an LG C4 a high-bitrate remux showed ~8 s of
 * black screen with no spinner. The loading screen now stays until the
 * reported time moves forward (at most 30 s). Native players report time
 * only while playing, and a paused start never advances; neither waits.
 * The JellyfinPlayer methods under test are taken from the source and run on
 * a stub player (the module itself needs a full DOM).
 * ============================================================================
 */

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

function extractConstant(name) {
    const match = source.match(new RegExp(`\\nconst ${name} = [^;]+;`));
    return match ? match[0] : '';
}

const playerEventSource = source
    .slice(source.indexOf('export const PlayerEvent = {'), source.indexOf('};', source.indexOf('export const PlayerEvent = {')) + 2)
    .replace('export const', 'const');

const METHODS = [
    '_handleBackendEvent(event) {',
    '_isAwaitingResumeAdvance(time) {',
    '_finishResumeWait(message) {',
    '_clearResumeAdvanceWait() {'
];

const RESUME_S = 1311.476;

function createPlayer({ backendType = 'webos', autoPlay } = {}) {
    const context = vm.createContext({
        setTimeout,
        clearTimeout,
        Date,
        Math,
        console,
        log: { info() {}, debug() {}, warn() {}, error() {} },
        PlayerSettings: { get: () => undefined }
    });
    const methods = vm.runInContext(
        `${playerEventSource}\n${extractConstant('REMUX_WATCHDOG_MAX_MS')}\n${extractConstant('RESUME_ADVANCE_WAIT_MS')}\n({\n${METHODS.filter(
            (m) => source.includes(`\n    ${m}`)
        )
            .map(extractMethod)
            .join(',\n')}\n})`,
        context
    );
    return Object.assign(Object.create(methods), {
        events: [],
        _playRequestId: 1,
        _backendType: backendType,
        _currentPlayOptions: { itemId: 'item', autoPlay },
        _pendingStartPositionTicks: Math.round(RESUME_S * 10000000),
        _resumeWaitStartTime: Date.now(),
        _resumeLastTime: null,
        _resumeAdvanceTimer: null,
        _transcodingOffsetTicks: 0,
        _remuxWatchdogActive: false,
        _isSeeking: false,
        _isPaused: true,
        _subtitleManager: { play() {}, pause() {}, tick() {} },
        emit(type) {
            this.events.push(type);
        },
        getCurrentPositionTicks: () => Math.round(RESUME_S * 10000000)
    });
}

const timeUpdate = (player, time) => player._handleBackendEvent({ type: 'timeupdate', data: { time } });
const playingCount = (player) => player.events.filter((e) => e === 'playing').length;

test('JellyfinPlayer: a resume that only landed keeps the loading screen until playback advances', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const player = createPlayer();

    // The seek lands at metadata time: no frame decoded yet
    timeUpdate(player, RESUME_S);
    timeUpdate(player, RESUME_S);
    t.mock.timers.tick(8000);
    timeUpdate(player, RESUME_S);
    assert.strictEqual(playingCount(player), 0, 'loading screen dismissed before a frame played');
    assert.ok(!player.events.includes('timeupdate'), 'time reported while the loading screen is up');

    // Frames start: time moves
    timeUpdate(player, RESUME_S + 0.15);
    assert.strictEqual(playingCount(player), 1);
    assert.strictEqual(player._pendingStartPositionTicks, null);
    assert.strictEqual(player._isPaused, false);

    // No second dismissal from the limit timer
    t.mock.timers.tick(60000);
    assert.strictEqual(playingCount(player), 1);
});

test('JellyfinPlayer: the loading screen is not held for good on a start that never moves', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const player = createPlayer({ backendType: 'html5' });

    timeUpdate(player, RESUME_S);
    t.mock.timers.tick(29000);
    assert.strictEqual(playingCount(player), 0);
    t.mock.timers.tick(1000);
    assert.strictEqual(playingCount(player), 1);
    assert.strictEqual(player._pendingStartPositionTicks, null);
});

test('JellyfinPlayer: a stopped start is not dismissed late by the limit timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const player = createPlayer();

    timeUpdate(player, RESUME_S);
    // stop(): new request token, wait cleared
    player._playRequestId++;
    player._clearResumeAdvanceWait();
    t.mock.timers.tick(60000);
    assert.strictEqual(playingCount(player), 0);
});

test('JellyfinPlayer: native players and paused starts dismiss the loading screen on landing (guard)', () => {
    const avplay = createPlayer({ backendType: 'tizen' });
    timeUpdate(avplay, RESUME_S);
    assert.strictEqual(playingCount(avplay), 1);

    const paused = createPlayer({ autoPlay: false });
    timeUpdate(paused, RESUME_S);
    assert.strictEqual(playingCount(paused), 1);
});
