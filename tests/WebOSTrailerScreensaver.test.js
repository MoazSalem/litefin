import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Trailer Screensaver Test Suite
 * ============================================================================
 * Remote trailers play YouTube inside an iframe. webOS only holds off its
 * screensaver for full-screen video the app plays itself, and the trailer sends
 * none of the player:* events, so the TV's screensaver (and Litefin's own one)
 * started in the middle of a trailer.
 *
 * TrailerPlayer now reports trailer:playing / trailer:paused / trailer:stopped;
 * WebOSAdapter blocks the TV screensaver while a trailer plays (whatever
 * pref:suppressScreensaverOnPlayback says) and ScreensaverManager stays hidden.
 * The methods are taken from the sources and run on stubs.
 * ============================================================================
 */

function readSource(path) {
    return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

const adapterSource = readSource('../src/webos/WebOSAdapter.js');
const trailerSource = readSource('../src/components/TrailerPlayer.js');
const screensaverSource = readSource('../src/core/ScreensaverManager.js');

function extractMethod(source, signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.notStrictEqual(start, -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

function buildMethods(source, signatures, context) {
    return vm.runInContext(
        `({\n${signatures.map((signature) => extractMethod(source, signature)).join(',\n')}\n})`,
        vm.createContext(context)
    );
}

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };

/** Records eventBus.on handlers and emitted events. */
function createEventBus() {
    const handlers = {};
    const emitted = [];
    return {
        handlers,
        emitted,
        on(event, callback) {
            (handlers[event] = handlers[event] || []).push(callback);
            return () => {
                handlers[event] = handlers[event].filter((cb) => cb !== callback);
            };
        },
        emit(event, ...args) {
            emitted.push(event);
            (handlers[event] || []).slice().forEach((cb) => cb(...args));
        }
    };
}

// ============================================================================
// WebOSAdapter
// ============================================================================

/** WebOSAdapter on a TV whose Luna calls are recorded and answered at once. */
function createAdapter({ suppressPref = false } = {}) {
    const calls = [];
    let nextActivityId = 1;
    const window = {
        webOS: {
            service: {
                request(uri, { method, parameters, onSuccess }) {
                    calls.push(`${method}${parameters.activityId ?? ''}`);
                    if (method === 'create') onSuccess({ returnValue: true, activityId: nextActivityId++ });
                }
            }
        }
    };
    const eventBus = createEventBus();
    const methods = buildMethods(
        adapterSource,
        [
            '_setupScreensaverGuard() {',
            'setKeepScreenOn(keepOn = true) {',
            'setTrailerKeepScreenOn(keepOn) {',
            '_createKeepScreenActivity() {',
            '_cancelKeepScreenActivity() {'
        ],
        {
            log: quietLog,
            window,
            JSON,
            eventBus,
            storage: {
                getItem: (key) => (key === 'pref:suppressScreensaverOnPlayback' ? String(suppressPref) : null)
            }
        }
    );
    const adapter = Object.assign(Object.create(methods), {
        _isWebOS: true,
        _screenSaverBlocked: false,
        _keepScreenActivityId: null,
        _keepScreenActivityPending: false,
        _isPlaybackKeepOnRequested: false,
        _isTrailerKeepOnRequested: false,
        _pendingBridges: [],
        _registerScreenSaverGuard() {}
    });
    adapter._setupScreensaverGuard();
    return { adapter, eventBus, calls };
}

test('webOS trailer screensaver: a playing trailer blocks the TV screensaver with the setting at its default (off)', () => {
    const { adapter, eventBus, calls } = createAdapter();

    eventBus.emit('trailer:playing');
    assert.strictEqual(adapter._screenSaverBlocked, true, 'tvpower requests would still be answered with ack: true');
    assert.deepStrictEqual(calls, ['create']);

    eventBus.emit('trailer:paused');
    assert.strictEqual(adapter._screenSaverBlocked, false, 'a paused trailer must let the screensaver run');
    assert.deepStrictEqual(calls, ['create', 'cancel1']);

    eventBus.emit('trailer:playing');
    eventBus.emit('trailer:stopped');
    assert.strictEqual(adapter._screenSaverBlocked, false);
    assert.deepStrictEqual(calls, ['create', 'cancel1', 'create', 'cancel2']);
});

test('webOS trailer screensaver: main playback still follows the setting', () => {
    const { adapter, eventBus, calls } = createAdapter({ suppressPref: false });

    eventBus.emit('player:playing');
    assert.strictEqual(adapter._screenSaverBlocked, false, 'the setting is off: playback must not block');
    assert.deepStrictEqual(calls, []);

    const withPref = createAdapter({ suppressPref: true });
    withPref.eventBus.emit('player:playing');
    assert.strictEqual(withPref.adapter._screenSaverBlocked, true);
});

test('webOS trailer screensaver: player events do not end the hold of a playing trailer, and the other way round', () => {
    const { adapter, eventBus, calls } = createAdapter({ suppressPref: true });

    eventBus.emit('trailer:playing');
    eventBus.emit('player:stopped');
    assert.strictEqual(adapter._screenSaverBlocked, true, 'player:stopped released the hold of a playing trailer');

    eventBus.emit('player:playing');
    eventBus.emit('trailer:stopped');
    assert.strictEqual(adapter._screenSaverBlocked, true, 'trailer:stopped released the hold of playback');

    eventBus.emit('player:stopped');
    assert.strictEqual(adapter._screenSaverBlocked, false);
    assert.deepStrictEqual(calls, ['create', 'cancel1']);
});

test('webOS trailer screensaver: repeated trailer reports change nothing', () => {
    const { adapter, eventBus, calls } = createAdapter();

    eventBus.emit('trailer:playing');
    eventBus.emit('trailer:playing');
    eventBus.emit('trailer:paused');
    eventBus.emit('trailer:paused');
    assert.deepStrictEqual(calls, ['create', 'cancel1']);
    assert.strictEqual(adapter._screenSaverBlocked, false);
});

// ============================================================================
// TrailerPlayer
// ============================================================================

/** TrailerPlayer state handlers on stub DOM elements. */
function createTrailerPlayer() {
    const eventBus = createEventBus();
    const document = { hidden: false, removeEventListener() {} };
    const element = () => ({ innerHTML: '', textContent: '', style: {}, value: 0 });
    const methods = buildMethods(
        trailerSource,
        [
            '_reportTrailerPlaying(playing) {',
            '_onYTStateChange(event) {',
            '_onProxyMessage(ev) {',
            '_updateProgress() {',
            'onBeforeDestroy() {'
        ],
        {
            eventBus,
            document,
            window: { removeEventListener() {} },
            osdIcons: { play: 'play', pause: 'pause' },
            PlayerSettings: { get: () => null },
            focusManager: { unregister() {}, focusElement() {} },
            setTimeout: () => 0,
            clearInterval() {},
            clearTimeout() {}
        }
    );
    const actions = [];
    const player = Object.assign(Object.create(methods), {
        _reportedPlaying: false,
        _isPlaying: true,
        _isProxy: true,
        _playPauseBtn: element(),
        _titleEl: element(),
        _currentTimeEl: element(),
        _totalTimeEl: element(),
        _positionFillEl: element(),
        _positionSliderEl: element(),
        _ytPlayer: null,
        _queueModalOverlay: null,
        _previousFocusTarget: null,
        _hideLoading() {},
        _resetAutoHide() {},
        _disableCaptions() {},
        _requestHighestQuality() {},
        _formatTicks: () => '0:00',
        _executeAction: (action) => actions.push(action)
    });
    player._offAppHidden = eventBus.on('app:hidden', () => player._reportTrailerPlaying(false));
    const trailerEvents = () => eventBus.emitted.filter((e) => e.startsWith('trailer:'));
    return { player, eventBus, document, actions, trailerEvents };
}

test('TrailerPlayer: YouTube API states are reported once per change, buffering keeps the last state', () => {
    const { player, actions, trailerEvents } = createTrailerPlayer();
    player._ytPlayer = { getVideoData: () => ({}) };

    player._onYTStateChange({ data: 3, target: {} }); // buffering before the first frame
    assert.deepStrictEqual(trailerEvents(), []);

    player._onYTStateChange({ data: 1, target: {} });
    player._onYTStateChange({ data: 3, target: {} });
    player._onYTStateChange({ data: 1, target: {} });
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing']);

    player._onYTStateChange({ data: 2, target: {} });
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing', 'trailer:paused']);

    player._onYTStateChange({ data: 1, target: {} });
    player._onYTStateChange({ data: 0, target: {} }); // ended: next trailer
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing', 'trailer:paused', 'trailer:playing', 'trailer:paused']);
    assert.deepStrictEqual(actions, ['next']);
});

test('TrailerPlayer: the proxy player (webOS default) reports from state changes and the time heartbeat', () => {
    const { player, trailerEvents } = createTrailerPlayer();
    const proxy = (msg) => player._onProxyMessage({ data: { __ytbridge: true, ...msg } });

    proxy({ type: 'time', t: 0, d: 90000, s: -1 }); // unstarted
    proxy({ type: 'title', data: 'Trailer', s: -1 });
    assert.deepStrictEqual(trailerEvents(), []);

    proxy({ type: 'state', data: 1 });
    proxy({ type: 'time', t: 500, d: 90000, s: 1 });
    proxy({ type: 'time', t: 1000, d: 90000, s: 1 });
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing']);

    proxy({ type: 'time', t: 1500, d: 90000, s: 2 });
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing', 'trailer:paused']);

    proxy({ type: 'state', data: 1 });
    proxy({ type: 'state', data: 0 }); // ended
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing', 'trailer:paused', 'trailer:playing', 'trailer:paused']);
});

test('TrailerPlayer: in the background a trailer does not count as playing until the heartbeat reports it again', () => {
    const { player, eventBus, document, trailerEvents } = createTrailerPlayer();
    const heartbeat = (s) => player._onProxyMessage({ data: { __ytbridge: true, type: 'time', t: 1, d: 2, s } });

    heartbeat(1);
    document.hidden = true;
    eventBus.emit('app:hidden');
    heartbeat(1); // still playing while hidden
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing', 'trailer:paused']);

    document.hidden = false;
    heartbeat(1);
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing', 'trailer:paused', 'trailer:playing']);
});

test('TrailerPlayer: the YouTube API progress heartbeat reports the state too', () => {
    const { player, document, trailerEvents } = createTrailerPlayer();
    let state = 1;
    player._ytPlayer = { getCurrentTime: () => 3, getDuration: () => 90, getPlayerState: () => state };

    document.hidden = true;
    player._updateProgress();
    assert.deepStrictEqual(trailerEvents(), []);

    document.hidden = false;
    player._updateProgress();
    state = 2;
    player._updateProgress();
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing', 'trailer:paused']);
});

test('TrailerPlayer: closing reports trailer:stopped and stops listening for app:hidden', () => {
    const { player, eventBus, trailerEvents } = createTrailerPlayer();
    player._isProxy = false;
    player._reportTrailerPlaying(true);

    player.onBeforeDestroy();
    assert.deepStrictEqual(trailerEvents(), ['trailer:playing', 'trailer:stopped']);
    assert.strictEqual(player._reportedPlaying, false);
    assert.deepStrictEqual(eventBus.handlers['app:hidden'], []);
});

// ============================================================================
// ScreensaverManager (Litefin's own screensaver)
// ============================================================================

test("ScreensaverManager: Litefin's screensaver stays off while a trailer plays", () => {
    const eventBus = createEventBus();
    const methods = buildMethods(screensaverSource, ['init() {', '_checkIdleTime() {'], {
        eventBus,
        log: quietLog,
        platformInfo: { isAndroid: false }
    });
    let shown = 0;
    let hidden = 0;
    let idleResets = 0;
    const manager = Object.assign(Object.create(methods), {
        _initialized: false,
        _isVideoPlaying: false,
        _isTrailerPlaying: false,
        _delaySeconds: 60,
        isShowing: false,
        _updateConfig() {},
        _getPlatformAdapter: () => ({ idleTime: 10 * 60 * 1000 }),
        _resetPlatformIdle: () => idleResets++,
        show: () => shown++,
        hide: () => hidden++
    });
    manager.init();

    eventBus.emit('trailer:playing');
    assert.strictEqual(hidden, 1, 'a showing screensaver is hidden when a trailer starts');
    manager._checkIdleTime();
    assert.strictEqual(shown, 0, 'the screensaver started over a playing trailer');

    eventBus.emit('trailer:paused');
    manager._checkIdleTime();
    assert.strictEqual(shown, 1, 'a paused trailer must let the screensaver run');

    eventBus.emit('trailer:stopped');
    assert.strictEqual(idleResets, 1, 'closing a trailer must restart the idle clock');
});
