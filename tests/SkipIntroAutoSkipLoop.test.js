import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// ============================================================================
// Skip Intro Plugin: Auto-Skip Loop Prevention Test Suite
// ============================================================================

// Read plugin source and strip static ES imports
const pluginSource = readFileSync(
    new URL('../src/plugins/installed/skip-intro/index.js', import.meta.url),
    'utf8'
)
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default skipIntroPlugin;', 'skipIntroPlugin;');

function setupPlugin() {
    const logs = [];
    const context = vm.createContext({
        i18n: {
            t: (key) => key,
            translateDOM() {}
        },
        PlayerSettings: {
            get: () => 'Skip'
        },
        document: {
            createElement: () => ({ innerHTML: '' }),
            activeElement: null
        }
    });

    const plugin = vm.runInContext(pluginSource, context);
    return plugin;
}

test('Skip Intro: auto-skip does not get stuck in an infinite seeking loop', () => {
    const plugin = setupPlugin();

    const seekCalls = [];
    let isSeeking = false;

    const mockPlayer = {
        get isSeeking() {
            return isSeeking;
        },
        seek(target) {
            seekCalls.push(target);
            isSeeking = true;
        },
        getDurationTicks() {
            return 27099580000; // ~2709 seconds
        },
        emit() {}
    };

    const mockApi = {
        getPlayer: () => mockPlayer,
        log: {
            info() {},
            warn() {},
            debug() {},
            error() {}
        }
    };

    // Simulate an intro segment: 264.0s to 310.31s (in Jellyfin 100ns ticks)
    // 264.0s = 2,640,000,000 ticks
    // 310.31s = 3,103,100,000 ticks
    plugin._autoSkipSegments = {
        intro: [{ start: 2640000000, end: 3103100000 }]
    };
    plugin._skippedSegments.clear();

    // 1. Playback enters the intro segment at 265s
    plugin.onTimeUpdate(2650000000, 27099580000, mockApi);

    // Assert seek was requested to 311.31s (end + 1s)
    assert.equal(seekCalls.length, 1);
    assert.equal(seekCalls[0], 3103100000 + 10000000); // 311.31s

    // 2. While player is seeking, further timeupdates arrive (at 265s or 311.31s)
    plugin.onTimeUpdate(2650000000, 27099580000, mockApi);
    plugin.onTimeUpdate(3113100000, 27099580000, mockApi);

    // Seek must NOT be called again while isSeeking is true
    assert.equal(seekCalls.length, 1, 'Should not seek while isSeeking is true');

    // 3. Hardware finishes seek or reports playing, clearing isSeeking
    isSeeking = false;

    // 4. Timeupdate fires at target position (311.31s)
    plugin.onTimeUpdate(3113100000, 27099580000, mockApi);
    assert.equal(seekCalls.length, 1, 'Should not seek when at or past target');

    // 5. Demuxer or GOP keyframe lands slightly before or reports intermediate position inside intro
    plugin.onTimeUpdate(2660000000, 27099580000, mockApi);
    plugin.onTimeUpdate(2700000000, 27099580000, mockApi);
    plugin.onTimeUpdate(3090000000, 27099580000, mockApi);

    // Because intro-0 has already been auto-skipped in this pass, NO additional seeks must fire!
    assert.equal(seekCalls.length, 1, 'intro-0 must remain guarded and not loop');

    // 6. User explicitly rewinds back before the intro started (< 264s - 2s = 262s)
    plugin.onTimeUpdate(2000000000, 27099580000, mockApi); // 200s

    // 7. Playback now advances forward into the intro again at 265s
    plugin.onTimeUpdate(2650000000, 27099580000, mockApi);

    // Now it should auto-skip again because the user intentionally rewound before the intro
    assert.equal(seekCalls.length, 2, 'Should re-arm and seek when rewound before intro');
});
