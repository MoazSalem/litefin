import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: the subtitle offset of native text track cues
 * ============================================================================
 * Cues added after an offset was applied (Hls.js WebVTT segments, a track
 * still loading) carry none. Each cue now keeps its own time, so it gets the
 * offset too and lands at the right time after switching tracks and back.
 * ============================================================================
 */

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = createEventTarget({
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement: (tag) =>
        createEventTarget({
            tagName: tag.toUpperCase(),
            classList: { add() {}, remove() {} },
            style: {},
            textTracks: [],
            setAttribute() {},
            appendChild() {}
        })
});

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

const cue = (start) => ({ startTime: start, endTime: start + 2 });
const times = (track) => track.cues.map((c) => [c.startTime, c.endTime]);

/** A player whose <video> has two native text tracks, the first one showing */
function playerWithTracks() {
    const player = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: () => {}
    });
    const video = player._ensureVideoElement();
    const tracks = [
        { mode: 'disabled', cues: [cue(10)] },
        { mode: 'disabled', cues: [cue(10)] }
    ];
    video.textTracks = tracks;
    player.setSubtitleStreamIndex(0);
    return { player, tracks };
}

test('WebOSPlayer: a cue added after the subtitle offset was set gets the whole offset', () => {
    const { player, tracks } = playerWithTracks();
    player.setSubtitleOffset(2);
    tracks[0].cues.push(cue(20)); // the next WebVTT segment arrives, without the offset

    player.setSubtitleOffset(3);
    assert.deepStrictEqual(times(tracks[0]), [
        [13, 15],
        [23, 25]
    ]);
});

test('WebOSPlayer: a late cue is back at its own time after switching tracks and back', () => {
    const { player, tracks } = playerWithTracks();
    player.setSubtitleOffset(2);
    tracks[0].cues.push(cue(20));
    player.setSubtitleOffset(3);

    // A track switch resets the offset
    player.setSubtitleStreamIndex(1);
    player.setSubtitleStreamIndex(0);
    assert.deepStrictEqual(times(tracks[0]), [
        [10, 12],
        [20, 22]
    ]);

    player.setSubtitleOffset(-1);
    assert.deepStrictEqual(times(tracks[0]), [
        [9, 11],
        [19, 21]
    ]);
    assert.deepStrictEqual(times(tracks[1]), [[10, 12]], 'a track not showing was moved');
});
