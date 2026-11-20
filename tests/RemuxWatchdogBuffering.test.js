import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Remux Watchdog Buffering Test Suite
 * ============================================================================
 * The remux stuck watchdog escalates a resumed remux to a transcode when the
 * playhead does not move for 8 s (a decoder frozen on a non-IDR start). On an
 * LG C4 a 4K Dolby Vision remux at ~120 Mbps was still filling its buffer at
 * 8 s (0.5 → 1.5 → 2.5 s ahead) and was escalated anyway: ~8 s of black
 * screen, then a second start as a 1080p H.264 transcode. While data keeps
 * arriving and little is buffered the watchdog now waits (up to 30 s);
 * buffered data the playhead does not move into is still a freeze.
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

function extractConstants() {
    const names = ['REMUX_WATCHDOG_FIRST_CHECK_MS', 'REMUX_WATCHDOG_RECHECK_MS', 'REMUX_WATCHDOG_MAX_MS', 'REMUX_STUCK_BUFFER_AHEAD_S'];
    return names
        .map((name) => {
            const match = source.match(new RegExp(`\\nconst ${name} = [^;]+;`));
            return match ? match[0] : `const ${name} = undefined;`;
        })
        .join('\n');
}

const playerEventSource = source
    .slice(source.indexOf('export const PlayerEvent = {'), source.indexOf('};', source.indexOf('export const PlayerEvent = {')) + 2)
    .replace('export const', 'const');

const METHODS = [
    '_armRemuxStuckWatchdog(targetTicks) {',
    '_scheduleRemuxWatchdogCheck(delayMs) {',
    '_getBackendBufferState() {',
    '_clearRemuxStuckWatchdog() {',
    '_handleRemuxWatchdogTimeout() {',
    'async _playAfterRestartPause(options, pauseMs) {'
];

/** A <video> whose playhead sits at the resume point while the test sets its buffered end. */
function fakeVideo(currentTime) {
    const video = {
        currentTime,
        bufferedEnd: null,
        get buffered() {
            const ranges = this.bufferedEnd === null ? [] : [[this.currentTime, this.bufferedEnd]];
            return { length: ranges.length, start: (i) => ranges[i][0], end: (i) => ranges[i][1] };
        }
    };
    return video;
}

function createPlayer({ video }) {
    const context = vm.createContext({
        setTimeout,
        clearTimeout,
        Date,
        Promise,
        Math,
        PlayerSettings: { get: () => true },
        log: { info() {}, debug() {}, warn() {}, error() {} }
    });
    const methods = vm.runInContext(
        `${playerEventSource}\n${extractConstants()}\n({\n${METHODS.filter((m) => source.includes(`\n    ${m}`))
            .map(extractMethod)
            .join(',\n')}\n})`,
        context
    );
    return Object.assign(Object.create(methods), {
        events: [],
        playCalls: [],
        _playRequestId: 0,
        _isRestarting: false,
        _remuxWatchdogTimeout: null,
        _remuxWatchdogActive: false,
        _remuxWatchdogTargetTicks: null,
        _remuxWatchdogInitialTime: null,
        _remuxWatchdogBufferedEnd: null,
        _backend: video ? { getVideoElement: () => video } : { stop() {} },
        _currentPlayOptions: { itemId: 'item', playbackMode: 'remux' },
        emit(type) {
            this.events.push(type);
        },
        async stop() {},
        async play(options) {
            this.playCalls.push(options);
        },
        getCurrentPositionTicks: () => 13114760000
    });
}

const RESUME_S = 1311.476;
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function advance(t, ms) {
    t.mock.timers.tick(ms);
    await flush();
    await flush();
}

const escalated = (player) => player.events.includes('restarting');

test('JellyfinPlayer: a remux still filling its buffer at 8 s is not escalated to a transcode', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const video = fakeVideo(RESUME_S);
    const player = createPlayer({ video });

    player._armRemuxStuckWatchdog(13114760000);
    // Same pace as on the LG C4: about 1 s of media per 0.7 s
    video.bufferedEnd = RESUME_S + 2.5;
    await advance(t, 8000);
    assert.ok(!escalated(player), 'remux escalated while its data was still arriving');

    // Still filling 4 s later, a segment buffered but the pipeline not started yet
    video.bufferedEnd = RESUME_S + 7;
    await advance(t, 4000);
    assert.ok(!escalated(player), 'remux escalated before it had more than a segment buffered');

    // Playback starts: the time update disarms the watchdog
    video.bufferedEnd = RESUME_S + 9;
    await advance(t, 4000);
    assert.ok(!escalated(player));
    player._clearRemuxStuckWatchdog();
    await advance(t, 30000);
    assert.ok(!escalated(player));
});

test('JellyfinPlayer: buffered data the playhead does not move into is still a freeze (guard)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const video = fakeVideo(RESUME_S);
    const player = createPlayer({ video });

    player._armRemuxStuckWatchdog(13114760000);
    // Two segments buffered and nothing played: the mid-GOP freeze
    video.bufferedEnd = RESUME_S + 12;
    await advance(t, 8000);
    assert.ok(escalated(player));
    await advance(t, 500);
    assert.strictEqual(player.playCalls[0]?.playbackMode, 'transcode');
});

test('JellyfinPlayer: a remux that buffers but never plays is escalated after 30 s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const video = fakeVideo(RESUME_S);
    const player = createPlayer({ video });

    player._armRemuxStuckWatchdog(13114760000);
    let elapsed = 0;
    while (!escalated(player) && elapsed < 40000) {
        // Slow trickle, never reaching the freeze threshold
        video.bufferedEnd = RESUME_S + Math.min(3.5, 0.1 + elapsed / 10000);
        await advance(t, 1000);
        elapsed += 1000;
    }
    assert.ok(escalated(player), 'never escalated');
    assert.ok(elapsed >= 30000 && elapsed <= 31000, `escalated after ${elapsed} ms`);
});

test('JellyfinPlayer: a remux with no data arriving is escalated at 8 s (guard)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const video = fakeVideo(RESUME_S);
    video.bufferedEnd = RESUME_S + 1;
    const player = createPlayer({ video });

    player._armRemuxStuckWatchdog(13114760000);
    await advance(t, 8000);
    assert.ok(escalated(player));
});

test('JellyfinPlayer: a backend without a media element keeps the 8 s escalation (guard)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const player = createPlayer({ video: null });

    player._armRemuxStuckWatchdog(13114760000);
    await advance(t, 8000);
    assert.ok(escalated(player));
});
