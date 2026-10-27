import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * PlayerPage Startup After Leaving Test Suite
 * ============================================================================
 * Back during the first loading spinner leaves the player while onInit() is
 * still waiting for the item details or the play queue (up to 2 s), or while
 * _startPlayback() waits for the plugins (Local Intros) or the item details.
 * When those arrived, the page went on to create the player, add its app,
 * network and remote control listeners and start playback for a page that
 * was already gone. It now stops there. The play request's hand-over state
 * (queue context, chosen version and tracks) is taken at once, so a page
 * left while loading no longer passes it on to the next playback.
 * PlayerPage.onInit(), _startPlayback() and destroy() are taken from the
 * source and run on a stub page (the module itself needs a full DOM).
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

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
    let resolve;
    const promise = new Promise((res) => (resolve = res));
    return { promise, resolve };
}

const noop = () => {};
const classList = { add: noop, remove: noop, contains: () => false };

/** State App.js leaves for the player page when the user picks version, audio and subtitles */
const HAND_OVER = {
    'player:contextType': 'boxset',
    'player:contextId': 'collection-1',
    'player:boxsetSortBy': 'SortName',
    'player:initialMediaSourceId': 'version-2',
    'player:initialAudioIndex': 3,
    'player:initialSubtitleIndex': 5
};

function createPage({ handOver = {} } = {}) {
    const item = deferred();
    const queue = deferred();
    const prepare = deferred();
    const details = deferred();
    const store = new Map(Object.entries(handOver));
    const calls = { queueInit: [], initPlayer: 0, listeners: [], getItem: 0 };

    const context = vm.createContext({
        Promise,
        parseInt,
        isNaN,
        setTimeout,
        clearTimeout,
        clearInterval,
        log: quietLog,
        window: {
            addEventListener: (type) => calls.listeners.push(`window:${type}`),
            removeEventListener: noop
        },
        document: {
            body: { classList },
            documentElement: { classList },
            addEventListener: (type) => calls.listeners.push(`document:${type}`),
            removeEventListener: noop,
            getElementById: () => null,
            querySelector: () => null
        },
        api: {
            // The page's item, then _startPlayback()'s metadata backfill
            getItem: () => (calls.getItem++ === 0 ? item.promise : details.promise),
            getServerConfiguration: () => Promise.resolve(null)
        },
        playQueue: {
            init: (...args) => {
                calls.queueInit.push(args.slice(1));
                return queue.promise;
            },
            getCurrentItem: () => null
        },
        pluginManager: { prepareItemPlayback: () => prepare.promise },
        state: { get: (key) => (store.has(key) ? store.get(key) : null), set: (key, value) => store.set(key, value) },
        eventBus: { on: (event) => calls.listeners.push(`eventBus:${event}`), off: noop },
        globalClock: { setVisibility: noop },
        focusManager: { suspend: noop, resume: noop, unregister: noop, invalidateCache: noop },
        platformInfo: { isAndroid: false, isWebOS: true },
        webosAdapter: { setKeepScreenOn: noop },
        androidAdapter: { setOrientation: noop },
        SubtitleStyles: { getCurrentFontId: () => null },
        FontLoader: { loadFont: () => Promise.resolve() },
        prewarmManager: { getPrewarmedItem: () => null },
        PlayerSettings: { get: () => null, getAdjustedResumePositionTicks: (ticks) => ticks },
        storage: { getItem: () => null },
        imageService: { getParams: () => ({}) },
        BackdropManager: { getBackdropUrl: () => null }
    });
    const methods = vm.runInContext(
        `({\n${['async onInit() {', 'async _startPlayback() {', 'destroy() {'].map(extractMethod).join(',\n')}\n})`,
        context
    );
    // Page.destroy() (super.destroy() in PlayerPage.destroy())
    Object.setPrototypeOf(methods, { destroy() {} });

    const page = Object.assign(Object.create(methods), {
        params: { id: 'movie' },
        el: null,
        _player: null,
        _osd: null,
        _hasReportedStart: false,
        _isExiting: false,
        _isDestroyed: false,
        _playingItemId: null,
        _showLoading: noop,
        _applyLoadingBackdrop: noop,
        _cancelAutoRecovery: noop,
        _stopPauseReportTimer: noop,
        _clearPlaybackStallWatchdog: noop,
        _showError: noop,
        on: (event) => calls.listeners.push(`page:${event}`),
        $: () => null,
        _initPlayer() {
            calls.initPlayer++;
            // The rest of the startup is not under test
            throw new Error('player started');
        }
    });
    return { page, calls, store, item, queue, prepare, details };
}

test('PlayerPage: Back while the play queue loads does not start the player afterwards', async () => {
    const { page, calls, item, queue } = createPage();

    const init = page.onInit();
    item.resolve({ Id: 'movie', Type: 'Movie', Name: 'Movie' });
    await flush();
    assert.strictEqual(calls.queueInit.length, 1);

    // Back: _stopAndExit() navigates away and the router destroys the page
    page._isExiting = true;
    page.destroy();
    queue.resolve();
    await init;

    assert.strictEqual(calls.initPlayer, 0, 'a player was created for a page that is gone');
    assert.deepStrictEqual(calls.listeners, [], 'listeners were added after the page was destroyed');
});

test('PlayerPage: Back while the item details load does not touch the play queue afterwards', async () => {
    const { page, calls, item, queue } = createPage();

    const init = page.onInit();
    await flush();
    page._isExiting = true;
    page.destroy();
    item.resolve({ Id: 'movie', Type: 'Movie', Name: 'Movie' });
    queue.resolve();
    await init;

    assert.strictEqual(calls.queueInit.length, 0, 'the play queue of the next playback can be replaced');
    assert.strictEqual(calls.initPlayer, 0);
});

test('PlayerPage: a page that was destroyed without Back does not start the player either', async () => {
    const { page, calls, item, queue } = createPage();

    const init = page.onInit();
    item.resolve({ Id: 'movie', Type: 'Movie', Name: 'Movie' });
    await flush();
    // e.g. a remote control navigates away
    page.destroy();
    queue.resolve();
    await init;

    assert.strictEqual(page._isDestroyed, true);
    assert.strictEqual(calls.initPlayer, 0);
});

test('PlayerPage: without leaving, the player is started once the queue is ready', async () => {
    const { page, calls, store, item, queue } = createPage({ handOver: HAND_OVER });

    const init = page.onInit();
    item.resolve({ Id: 'movie', Type: 'Movie', Name: 'Movie' });
    await flush();
    queue.resolve();
    await init;

    assert.strictEqual(calls.initPlayer, 1);
    assert.deepStrictEqual(calls.queueInit, [['boxset', 'collection-1', 'SortName']]);
    assert.deepStrictEqual(
        { ...page._initialSelection },
        { mediaSourceId: 'version-2', audioIndex: 3, subtitleIndex: 5 }
    );
    for (const key of Object.keys(HAND_OVER)) assert.strictEqual(store.get(key), null, key);
});

test('PlayerPage: Back while the item details load leaves no play request state for the next playback', async () => {
    const { page, store, item, queue } = createPage({ handOver: HAND_OVER });

    const init = page.onInit();
    await flush();
    page._isExiting = true;
    page.destroy();
    item.resolve({ Id: 'movie', Type: 'Movie', Name: 'Movie' });
    queue.resolve();
    await init;

    // The next title (Continue Watching, Next Up…) would start with audio track 3
    // and the old collection's queue
    for (const key of Object.keys(HAND_OVER)) assert.strictEqual(store.get(key), null, `${key} left behind`);
});

test('PlayerPage: a page left while loading does not clear the next play request', async () => {
    const { page, store, item, queue } = createPage({ handOver: HAND_OVER });

    const init = page.onInit();
    await flush();
    page._isExiting = true;
    page.destroy();
    // The user starts another title before the old item details arrive
    store.set('player:contextType', 'playlist');
    store.set('player:initialAudioIndex', 7);
    item.resolve({ Id: 'movie', Type: 'Movie', Name: 'Movie' });
    queue.resolve();
    await init;

    assert.strictEqual(store.get('player:contextType'), 'playlist');
    assert.strictEqual(store.get('player:initialAudioIndex'), 7);
});

test('PlayerPage: Back while a plugin prepares the item (Local Intros) does not start playback', async () => {
    const { page, prepare } = createPage();
    page._item = { Id: 'movie', Type: 'Movie', RunTimeTicks: 72000000000 };
    page._initialSelection = { mediaSourceId: null, audioIndex: 3, subtitleIndex: null };

    const starting = page._startPlayback();
    await flush();
    page._isExiting = true;
    page.destroy();
    prepare.resolve();
    await starting;

    assert.strictEqual(page._playingItemId, null, 'playback went on for a page that is gone');
    assert.strictEqual(page._initialSelection.audioIndex, 3);
});

test('PlayerPage: Back while _startPlayback() loads missing item details does not start playback', async () => {
    const { page, calls, prepare, details } = createPage();
    page._item = { Id: 'episode', Type: 'Episode' };
    prepare.resolve();
    calls.getItem = 1; // onInit() fetched the page's item before

    const starting = page._startPlayback();
    await flush();
    page._isExiting = true;
    page.destroy();
    details.resolve({ Id: 'episode', RunTimeTicks: 1 });
    await starting;

    assert.strictEqual(page._playingItemId, null, 'playback went on for a page that is gone');
});

test('PlayerPage: without leaving, _startPlayback() goes on with the chosen tracks', async () => {
    const { page, prepare } = createPage();
    page._item = { Id: 'movie', Type: 'Movie', RunTimeTicks: 72000000000 };
    page._initialSelection = { mediaSourceId: null, audioIndex: 3, subtitleIndex: null };

    prepare.resolve();
    // The rest of the start needs the real player modules
    await page._startPlayback().catch(() => {});

    assert.strictEqual(page._playingItemId, 'movie');
    assert.strictEqual(page._preSelectedAudio, 3);
    assert.strictEqual(page._initialSelection.audioIndex, null, 'the choice applies to the next item as well');
});
