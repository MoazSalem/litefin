import assert from 'node:assert/strict';
import test from 'node:test';

// Minimal browser globals required by PlayerSettings, api, and PlaybackSpeedMenu
const memoryStorage = new Map();
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
    removeEventListener: () => {}
};
globalThis.localStorage = {
    getItem: (k) => (memoryStorage.has(k) ? memoryStorage.get(k) : null),
    setItem: (k, v) => {
        memoryStorage.set(k, String(v));
    },
    removeItem: (k) => {
        memoryStorage.delete(k);
    },
    clear: () => {
        memoryStorage.clear();
    }
};
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        addEventListener: () => {},
        querySelectorAll: () => [],
        appendChild: () => {},
        innerHTML: ''
    }),
    body: {
        appendChild: () => {}
    }
};

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const { api } = await import('../src/api/index.js');
const { syncPlayManager } = await import('../src/core/syncplay/SyncPlayManager.js');
const { default: PlaybackSpeedMenu } = await import('../src/player/osd/PlaybackSpeedMenu.js');

Object.defineProperty(api, 'userId', { value: 'user-1', configurable: true });

function resetState() {
    memoryStorage.clear();
    PlayerSettings.set('rememberPlaybackSpeed', 'off');
    syncPlayManager._isEnabled = false;
}

test('PlayerSettings: off mode always returns 1x and does not persist speeds', () => {
    resetState();
    const episode = { Id: 'ep-1', SeriesId: 'series-a' };

    PlayerSettings.rememberSpeed(episode, 'user-1', 1.5);
    assert.equal(PlayerSettings.getRememberedSpeed(episode, 'user-1'), 1);
    assert.equal(memoryStorage.has('player:speed:user-1:series-a'), false);
    assert.equal(memoryStorage.has('player:speed:user-1:all'), false);
});

test('PlayerSettings: series mode isolates speeds per series and defaults non-episodes to 1x', () => {
    resetState();
    PlayerSettings.set('rememberPlaybackSpeed', 'series');

    const seriesAEp = { Id: 'ep-1', SeriesId: 'series-a' };
    const seriesBEp = { Id: 'ep-2', SeriesId: 'series-b' };
    const movie = { Id: 'mov-1' };

    PlayerSettings.rememberSpeed(seriesAEp, 'user-1', 1.5);
    PlayerSettings.rememberSpeed(movie, 'user-1', 1.75);

    assert.equal(PlayerSettings.getRememberedSpeed(seriesAEp, 'user-1'), 1.5);
    assert.equal(PlayerSettings.getRememberedSpeed(seriesBEp, 'user-1'), 1);
    assert.equal(PlayerSettings.getRememberedSpeed(movie, 'user-1'), 1);
    assert.equal(PlayerSettings.getRememberedSpeed(seriesAEp, 'user-2'), 1);
});

test('PlayerSettings: all mode applies speed across all items and clears key when set to 1x', () => {
    resetState();
    PlayerSettings.set('rememberPlaybackSpeed', 'all');

    const movie = { Id: 'mov-1' };
    const episode = { Id: 'ep-1', SeriesId: 'series-a' };

    PlayerSettings.rememberSpeed(movie, 'user-1', 1.25);
    assert.equal(PlayerSettings.getRememberedSpeed(episode, 'user-1'), 1.25);

    // Setting back to 1x should remove the stored key cleanly
    PlayerSettings.rememberSpeed(episode, 'user-1', 1);
    assert.equal(PlayerSettings.getRememberedSpeed(movie, 'user-1'), 1);
    assert.equal(memoryStorage.has('player:speed:user-1:all'), false);
});

test('PlayerSettings: falsy userId is ignored without writing stray storage keys', () => {
    resetState();
    PlayerSettings.set('rememberPlaybackSpeed', 'all');
    const movie = { Id: 'mov-1' };

    PlayerSettings.rememberSpeed(movie, null, 1.5);
    PlayerSettings.rememberSpeed(movie, undefined, 1.5);
    PlayerSettings.rememberSpeed(movie, '', 1.5);

    assert.equal(PlayerSettings.getRememberedSpeed(movie, null), 1);
    assert.equal(memoryStorage.has('player:speed:null:all'), false);
    assert.equal(memoryStorage.has('player:speed:undefined:all'), false);
    assert.equal(memoryStorage.has('player:speed::all'), false);
});

test('PlaybackSpeedMenu: remembers speed on selection unless SyncPlay is active', () => {
    resetState();
    PlayerSettings.set('rememberPlaybackSpeed', 'all');

    const item = { Id: 'ep-1', SeriesId: 'series-a' };
    const appliedSpeeds = [];
    const mockOsd = {
        player: {
            getBackendType: () => 'html5',
            getPlaybackSpeed: () => 1,
            setPlaybackSpeed: (s) => appliedSpeeds.push(s),
            getCurrentItem: () => item
        },
        closeMenu: () => {},
        _getFocused: () => null,
        _currentFocusRow: 0,
        _currentFocusIndex: 0,
        _updateFocus: () => {}
    };

    const menu = new PlaybackSpeedMenu(mockOsd);
    const idx15 = menu.options.findIndex((o) => o.id === 1.5);
    const idx125 = menu.options.findIndex((o) => o.id === 1.25);

    // Normal playback saves picked speed
    menu.focusIndex = idx15;
    menu.handleEnter();
    assert.equal(PlayerSettings.getRememberedSpeed(item, 'user-1'), 1.5);

    // SyncPlay active: still applies to player, but does not overwrite remembered speed
    syncPlayManager._isEnabled = true;
    menu.focusIndex = idx125;
    menu.handleEnter();
    assert.deepEqual(appliedSpeeds, [1.5, 1.25]);
    assert.equal(PlayerSettings.getRememberedSpeed(item, 'user-1'), 1.5);
});
