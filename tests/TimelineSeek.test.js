import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Load the actual OSD class with browser imports isolated. No copied seek logic
// and no browser/test dependencies are needed for the remote state machine.
const source = readFileSync(new URL('../src/player/osd/OSDController.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default class OSDController', 'class OSDController');

function arrowEvent(repeat = false) {
    return { repeat, preventDefault() {}, stopPropagation() {} };
}

function setup(enabled = true, paused = false) {
    let now = 1000;
    let nextTimer = 1;
    const timers = new Map();
    const settings = { confirmSeekWithOK: enabled, skipBackLength: 5000, skipForwardLength: 10000 };
    const context = vm.createContext({
        Component: class {},
        document: {
            addEventListener() {},
            removeEventListener() {},
            getElementById() {
                return null;
            }
        },
        logger: {
            create: () => ({
                info() {},
                error(e, detail) {
                    throw new Error(e, { cause: detail });
                },
                warn() {}
            })
        },
        PlayerSettings: { get: (key) => settings[key] },
        Date: { now: () => now },
        setTimeout: (fn, delay) => {
            const id = nextTimer++;
            timers.set(id, { fn, at: now + delay });
            return id;
        },
        clearTimeout: (id) => timers.delete(id)
    });
    const OSD = vm.runInContext(source + '\nOSDController;', context);
    const osd = Object.create(OSD.prototype);
    const seeks = [];
    let position = 100 * 10000000;
    const tooltip = { classList: { add() {}, remove() {} }, style: {} };
    Object.assign(osd, {
        _seekTargetTicks: null,
        _seekStartTime: null,
        _seekDebounceTimer: null,
        _seekRequiresConfirmation: false,
        _seekLastInputTime: null,
        _seekConfirmTime: null,
        _seekResumePlayback: false,
        _seekHeldDirection: null,
        _seekHoldElapsed: 0,
        _seekHoldTimer: null,
        _isOsdVisible: true,
        _currentFocusRow: 2,
        activeMenu: null,
        lyricsModal: {},
        _config: { autoHideDelay: 5000 },
        _cachedTooltipEl: tooltip,
        _cachedTooltipTextEl: {},
        _osdEl: { querySelector: () => tooltip },
        on() {},
        _player: {
            getCurrentPositionTicks: () => position,
            getDurationTicks: () => 3600 * 10000000,
            isPaused: () => paused,
            pause() {
                paused = true;
            },
            unpause() {
                paused = false;
            },
            seek: (ticks) => {
                seeks.push(ticks);
                position = ticks;
            }
        },
        show() {
            this.resetAutoHide();
        },
        _updateTimeDisplay(player) {
            this.display = player.getCurrentPositionTicks();
        },
        _updatePositionSlider(player) {
            this.slider = player.getCurrentPositionTicks();
        },
        _updateTrickplayTooltip(ticks) {
            this.thumbnail = ticks;
        },
        _hideTrickplayThumb() {},
        _updateClock() {},
        updatePlayPauseButton() {},
        _clearMagicHover() {},
        _updateFocus() {},
        _executeAction(action) {
            if (action === 'togglePlay') paused = !paused;
            else this._performDebouncedSeek((action === 'rewind' ? -5000 : 10000) * 10000);
        }
    });
    return {
        osd,
        seeks,
        timers,
        timerApi: { setTimeout: context.setTimeout, clearTimeout: context.clearTimeout },
        settings,
        position: (ticks) => {
            position = ticks;
        },
        advance(ms, runTimers = true) {
            now += ms;
            if (!runTimers) return;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now && timers.has(id)) {
                    timers.delete(id);
                    timer.fn();
                }
            }
        }
    };
}

for (const paused of [false, true]) {
    test(`preview, wait, OK and repeated OK preserve paused=${paused}`, () => {
        const { osd, seeks, advance } = setup(true, paused);
        osd.handleInput('right');
        assert.equal(osd.display, 110 * 10000000);
        assert.equal(osd.slider, osd.display);
        assert.equal(osd.thumbnail, osd.display);
        advance(31000);
        osd._updateState();
        assert.equal(osd._seekTargetTicks, 110 * 10000000);
        assert.deepEqual(seeks, []);
        assert.equal(osd._player.isPaused(), true);
        osd.handleInput('enter');
        for (let i = 0; i < 20; i++) {
            advance(100);
            osd.handleInput('enter');
        }
        assert.deepEqual(seeks, [110 * 10000000]);
        assert.equal(osd._player.isPaused(), paused);
    });
}

test('Back cancels to the real current position without seeking', () => {
    const { osd, seeks, position, advance } = setup();
    osd.handleInput('left');
    position(115 * 10000000);
    osd.handleInput('back');
    assert.equal(osd.display, 115 * 10000000);
    assert.equal(osd.slider, osd.display);
    assert.equal(osd._seekTargetTicks, null);
    advance(1000);
    assert.deepEqual(seeks, []);
});

test('long hold accelerates, a new burst resets acceleration, and bounds clamp', () => {
    const { osd, seeks, advance } = setup();
    for (let i = 0; i < 150; i++) {
        osd.handleInput('right', arrowEvent(i > 0));
        advance(100);
    }
    assert.deepEqual(seeks, []);
    assert.equal(osd._seekTargetTicks, 3600 * 10000000);
    advance(900);
    osd.handleInput('left');
    assert.equal(osd._seekTargetTicks, 3595 * 10000000);
    osd._performDebouncedSeek(-1e15, true);
    assert.equal(osd._seekTargetTicks, 0);
    osd.handleInput('enter');
    assert.deepEqual(seeks, [0]);
});

test('disabled option preserves 800ms debounce and accumulated seeks', () => {
    const { osd, seeks, advance } = setup(false);
    osd.handleInput('right');
    advance(400);
    osd.handleInput('right');
    advance(799);
    assert.deepEqual(seeks, []);
    advance(1);
    assert.deepEqual(seeks, [120 * 10000000]);
    assert.equal(osd._player.isPaused(), false);
});

test('confirmation cancels an older automatic timer', () => {
    const { osd, seeks, advance } = setup();
    osd._performDebouncedSeek(10 * 10000000);
    osd.handleInput('left');
    advance(1000);
    assert.deepEqual(seeks, []);
    osd.handleInput('enter');
    assert.deepEqual(seeks, [95 * 10000000]);
});

test('direct slider click replaces pending preview and seeks immediately', () => {
    const { osd, seeks, advance } = setup();
    osd.handleInput('right');
    osd._handlePositionSliderChange({ target: { value: 50 } });
    advance(1000);
    assert.deepEqual(seeks, [1800 * 10000000]);
    assert.equal(osd._seekTargetTicks, null);
});

test('quick seek remains automatic and does not commit pending preview', () => {
    const { osd, seeks, advance } = setup();
    osd.handleInput('right');
    osd._performDebouncedSeek(-5 * 10000000);
    advance(800);
    assert.deepEqual(seeks, [95 * 10000000]);
});

test('cleanup cancels timers and preview state', () => {
    const { osd, seeks, advance } = setup();
    osd._performDebouncedSeek(10 * 10000000);
    osd._clearSeekState();
    advance(1000);
    assert.deepEqual(seeks, []);
    assert.equal(osd._seekTargetTicks, null);
    assert.equal(osd._seekDebounceTimer, null);
});

function loadSeekMethod(file, signature, timerApi = {}) {
    const source = readFileSync(new URL(`../src/player/core/${file}.js`, import.meta.url), 'utf8');
    const start = source.indexOf(`    ${signature}`);
    const end = source.indexOf('\n    }', start) + 6;
    return vm.runInNewContext(`({${source.slice(start, end)}}).seek`, {
        ...timerApi,
        SEEK_THRESHOLD_MS: 100,
        log: { debug() {} }
    });
}

for (const backend of ['WebOSPlayer', 'HtmlVideoPlayer']) {
    for (const paused of [true, false]) {
        test(`${backend}: confirmed seek uses Jellyfin subtitle/event path and preserves paused=${paused}`, () => {
            const { osd, seeks, advance, timerApi } = setup(true, paused);
            let writes = 0;
            let time = 80;
            let resets = 0;
            const events = [];
            const video = {
                paused,
                get currentTime() {
                    return time;
                },
                set currentTime(value) {
                    writes++;
                    time = value;
                }
            };
            const native = {
                _videoElement: video,
                _currentPlayOptions: { transcodingOffsetTicks: 20 * 10000000 },
                onEvent() {},
                getCurrentTime: () => time,
                seek: loadSeekMethod(backend, 'seek(positionTicks) {', timerApi)
            };
            const player = {
                isPaused: () => video.paused,
                pause() {
                    video.paused = true;
                },
                unpause() {
                    video.paused = false;
                },
                _backend: native,
                _subtitleManager: {
                    resetActiveCues() {
                        resets++;
                    }
                },
                emit(name, data) {
                    events.push([name, data.positionTicks]);
                    osd._clearSeekState();
                },
                seek: loadSeekMethod('JellyfinPlayer', 'seek(positionTicks, options = {}) {'),
                getCurrentPositionTicks: () => (time + 20) * 10000000,
                getDurationTicks: () => 3600 * 10000000
            };
            osd._player = player;
            for (let i = 0; i < 5; i++) osd.handleInput('right');
            advance(1000);
            assert.equal(writes, 0);
            assert.equal(resets, 0);
            assert.deepEqual(events, []);
            osd.handleInput('enter');
            osd.handleInput('enter');
            advance(2500); // Run the upstream direct-play seek verification guard.
            assert.equal(writes, 1);
            assert.equal(time, 130);
            assert.equal(video.paused, paused);
            assert.equal(resets, 1);
            assert.deepEqual(events, [['seek', 150 * 10000000]]);
            assert.deepEqual(seeks, []);
        });
    }
}

test('preference defaults off, persists as a boolean and can be reset', () => {
    const source = readFileSync(new URL('../src/utils/PlayerSettings.js', import.meta.url), 'utf8')
        .replace(/^import .*;\r?\n/gm, '')
        .replace('export const PlayerSettings', 'const PlayerSettings')
        .replace('export default PlayerSettings;', 'PlayerSettings;');
    const saved = new Map();
    const settings = vm.runInNewContext(source, {
        platformInfo: {},
        logger: { create: () => ({ debug() {}, info() {} }) },
        eventBus: { emit() {} },
        storage: {
            getItem: (key) => saved.get(key) ?? null,
            setItem: (key, value) => saved.set(key, value),
            removeItem: (key) => saved.delete(key)
        }
    });
    // Default setting is off (false)
    assert.equal(settings.get('confirmSeekWithOK'), false);
    // Test setting to enabled
    settings.set('confirmSeekWithOK', true);
    assert.equal(saved.get('player:confirmSeekWithOK'), 'true');
    assert.equal(settings.get('confirmSeekWithOK'), true);
    // Reset back to default (false)
    settings.reset('confirmSeekWithOK');
    assert.equal(settings.get('confirmSeekWithOK'), false);
});

for (const hasRepeatMetadata of [true, false]) {
    test(`separate taps never accelerate (repeat metadata=${hasRepeatMetadata})`, () => {
        const { osd, advance } = setup();
        for (let i = 0; i < 50; i++) {
            osd.handleInput('right', hasRepeatMetadata ? arrowEvent(false) : undefined);
            advance(100);
        }
        assert.equal(osd._seekTargetTicks, 600 * 10000000);
    });
}

test('keyup resets acceleration immediately, even on a fast subsequent press', () => {
    const { osd, advance } = setup();
    osd._bindKeyEvents();
    for (let i = 0; i < 30; i++) {
        osd.handleInput('right', arrowEvent(i > 0));
        advance(100);
    }
    assert.match(osd._cachedTooltipTextEl.textContent, /4x/);
    const target = osd._seekTargetTicks;
    osd._onSeekKeyUp({ key: 'ArrowRight' });
    assert.doesNotMatch(osd._cachedTooltipTextEl.textContent, /x/);
    osd.handleInput('right', arrowEvent(true));
    assert.equal(osd._seekTargetTicks, target + 10 * 10000000);
});

test('missing keyup clears speed badge, and a fresh press resets without seeking', () => {
    const { osd, advance, seeks } = setup();
    for (let i = 0; i < 30; i++) {
        osd.handleInput('right', arrowEvent(i > 0));
        advance(100);
    }
    const target = osd._seekTargetTicks;
    advance(300);
    assert.equal(osd._seekHoldTimer, null);
    assert.doesNotMatch(osd._cachedTooltipTextEl.textContent, /x/);
    assert.equal(osd._player.isPaused(), true);
    assert.deepEqual(seeks, []);
    osd.handleInput('right', arrowEvent(false));
    assert.equal(osd._seekTargetTicks, target + 10 * 10000000);
});

test('changing direction resets the multiplier immediately', () => {
    const { osd, advance } = setup();
    for (let i = 0; i < 30; i++) {
        osd.handleInput('right', arrowEvent(i > 0));
        advance(100);
    }
    const target = osd._seekTargetTicks;
    osd.handleInput('left', arrowEvent(true));
    assert.equal(osd._seekTargetTicks, target - 5 * 10000000);
});

for (const paused of [true, false]) {
    test(`Back restores initial paused=${paused} and clears hold timer`, () => {
        const { osd, advance, seeks } = setup(true, paused);
        osd.handleInput('right');
        assert.equal(osd._player.isPaused(), true);
        osd.handleInput('back');
        assert.equal(osd._player.isPaused(), paused);
        assert.equal(osd._seekHoldTimer, null);
        advance(1000);
        assert.deepEqual(seeks, []);
    });
}

test('player teardown discards preview without restarting playback', () => {
    const { osd, advance } = setup();
    osd.handleInput('right');
    osd._clearSeekState(false);
    advance(1000);
    assert.equal(osd._player.isPaused(), true);
    assert.equal(osd._seekHoldTimer, null);
});

test('first hold reaches each faster multiplier at the intended thresholds', () => {
    const { osd, advance } = setup();
    osd.handleInput('right', arrowEvent(false));
    const thresholds = new Map([
        [750, 2],
        [1500, 3],
        [2250, 4],
        [3000, 5],
        [4500, 10]
    ]);
    for (let elapsed = 50; elapsed <= 4500; elapsed += 50) {
        advance(50);
        const previous = osd._seekTargetTicks;
        osd.handleInput('right', arrowEvent(true));
        if (thresholds.has(elapsed)) {
            const multiplier = thresholds.get(elapsed);
            assert.equal(osd._seekTargetTicks - previous, multiplier * 10 * 10000000);
            assert.match(osd._cachedTooltipTextEl.textContent, new RegExp(`\\(${multiplier}x\\)`));
        }
    }
});

for (const idleTimerRunsFirst of [true, false]) {
    test(`delayed repeat at first 2x preserves progression (idle timer first=${idleTimerRunsFirst})`, () => {
        const { osd, advance, seeks } = setup();
        osd.handleInput('right', arrowEvent(false));
        for (let i = 0; i < 8; i++) {
            advance(100);
            osd.handleInput('right', arrowEvent(true));
        }
        assert.match(osd._cachedTooltipTextEl.textContent, /2x/);
        const previous = osd._seekTargetTicks;
        if (idleTimerRunsFirst) advance(1100);
        else advance(1100, false);
        osd.handleInput('right', arrowEvent(true));
        assert.equal(osd._seekTargetTicks - previous, 20 * 10000000);
        assert.equal(osd._seekHoldElapsed, 1000);
        for (let i = 0; i < 5; i++) {
            advance(100);
            osd.handleInput('right', arrowEvent(true));
        }
        assert.match(osd._cachedTooltipTextEl.textContent, /3x/);
        assert.deepEqual(seeks, []);
        assert.equal(osd._player.isPaused(), true);
        osd.handleInput('right', arrowEvent(false));
        assert.equal(osd._seekHoldElapsed, 0);
        assert.doesNotMatch(osd._cachedTooltipTextEl.textContent, /x/);
    });
}
