import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * JellyfinPlayer Unpause During Seek Test Suite
 * ============================================================================
 * webOS carries out a seek on a paused element only once playback starts.
 * JellyfinPlayer held unpause() back until 'seeked' (or a 5 s failsafe), so
 * after a scrub in a paused native-HLS remux the picture stayed frozen and
 * Play did nothing. The webOS and HTML5 backends queue the play themselves
 * and start it when 'seeked' does not come, so the request goes straight to
 * them; AVPlay keeps the gate here.
 * ============================================================================
 */

const source = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function extractMethod(signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

function createPlayer(backendType) {
    const context = vm.createContext({
        log: { info() {}, debug() {}, warn() {}, error() {} },
        PlayerEvent: { PLAY: 'play' }
    });
    const methods = vm.runInContext(
        `({\n${extractMethod('unpause() {')},\n${extractMethod('get queuesPostSeekPlay() {')}\n})`,
        context
    );
    const calls = [];
    const player = Object.assign(Object.create(methods), {
        _backendType: backendType,
        _isPaused: true,
        _pendingPlayAfterSeek: false,
        isSeeking: true,
        _subtitleManager: { play() {} },
        _backend: { unpause: () => calls.push('backend.unpause') },
        emit: (type) => calls.push(`emit:${type}`)
    });
    return { player, calls };
}

for (const backendType of ['webos', 'html5']) {
    test(`JellyfinPlayer: unpause() during a seek goes straight to the ${backendType} backend`, () => {
        const { player, calls } = createPlayer(backendType);
        player.unpause();
        assert.deepStrictEqual(calls, ['emit:play', 'backend.unpause'], 'Play held back until a seeked event webOS may never send');
        assert.strictEqual(player._isPaused, false);
        assert.strictEqual(player._pendingPlayAfterSeek, false);
    });
}

test('JellyfinPlayer: unpause() during a seek is still queued for AVPlay (guard)', () => {
    const { player, calls } = createPlayer('tizen');
    player.unpause();
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(player._pendingPlayAfterSeek, true);
});
