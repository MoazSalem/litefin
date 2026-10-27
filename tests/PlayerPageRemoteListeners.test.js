import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import EventBus from '../src/core/EventBus.js';

/**
 * ============================================================================
 * PlayerPage Remote Control Listeners Test Suite
 * ============================================================================
 * The player page adds its remote control handlers (commands from the
 * Jellyfin app or a phone: play, pause, next, volume…, and the channel keys)
 * to the global event bus wrapped by the screen lock check, but destroy()
 * removed the unwrapped handlers, which are not on the bus. Every player page
 * of the app session kept its handlers: one Next from the app ran Next on
 * every closed player page too, each advancing the shared play queue. The
 * page now removes the listeners it added.
 * PlayerPage.onInit() and destroy() are taken from the source and run on stub
 * pages sharing a real EventBus (the module itself needs a full DOM).
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

const noop = () => {};
const classList = { add: noop, remove: noop, contains: () => false };

/** One app session: the event bus, log and TV volume its player pages share */
function createSession() {
    const bus = new EventBus();
    const added = new Set();
    const busOn = bus.on.bind(bus);
    bus.on = (event, callback) => {
        added.add(event);
        return busOn(event, callback);
    };
    // Remote control handlers log the command first ("Remote: NextTrack")
    const commands = [];
    const tvVolume = { steps: 0 };

    const context = vm.createContext({
        Promise,
        parseInt,
        isNaN,
        setTimeout,
        clearTimeout,
        clearInterval,
        log: {
            info: (message) => typeof message === 'string' && message.startsWith('Remote:') && commands.push(message),
            debug: noop,
            warn: noop,
            error: noop
        },
        window: { addEventListener: noop, removeEventListener: noop },
        document: {
            body: { classList },
            documentElement: { classList },
            addEventListener: noop,
            removeEventListener: noop,
            getElementById: () => null
        },
        api: { getItem: async (id) => ({ Id: id, Type: 'Movie', Name: 'Movie' }) },
        playQueue: { init: async () => {}, getCurrentItem: () => null },
        state: { get: () => null, set: noop },
        eventBus: bus,
        globalClock: { setVisibility: noop },
        focusManager: { suspend: noop, resume: noop, unregister: noop, invalidateCache: noop },
        platformInfo: { isAndroid: false, isWebOS: true },
        webosAdapter: { setKeepScreenOn: noop },
        androidAdapter: { setOrientation: noop },
        SubtitleStyles: { getCurrentFontId: () => null },
        FontLoader: { loadFont: async () => {} },
        prewarmManager: { getPrewarmedItem: () => null },
        PlayerSettings: { get: () => null },
        storage: { getItem: () => null },
        // Samsung: without a player, the volume keys change the TV volume
        tizen: {
            tvaudiocontrol: {
                setVolumeUp: () => tvVolume.steps++,
                setVolumeDown: () => tvVolume.steps--
            }
        }
    });
    const methods = vm.runInContext(
        `({\n${['async onInit() {', 'destroy() {'].map(extractMethod).join(',\n')}\n})`,
        context
    );
    // Component.on() and Component.destroy() (super.destroy() in PlayerPage.destroy())
    Object.setPrototypeOf(methods, {
        on(event, handler) {
            const unsubscribe = bus.on(event, handler);
            this._subscriptions.push(unsubscribe);
            return unsubscribe;
        },
        destroy() {
            for (const unsubscribe of this._subscriptions) unsubscribe();
            this._subscriptions = [];
        }
    });

    /** A player page whose playback has started */
    async function openPage(id) {
        const calls = { next: 0, previous: 0, lockIndicator: 0 };
        const page = Object.assign(Object.create(methods), {
            params: { id },
            el: { querySelector: () => null, addEventListener: noop, classList },
            _subscriptions: [],
            _player: null,
            _osd: null,
            _isExiting: false,
            _isDestroyed: false,
            _resumeProfileSelectionActive: false,
            _showLoading: noop,
            _cancelAutoRecovery: noop,
            _stopPauseReportTimer: noop,
            _clearPlaybackStallWatchdog: noop,
            _showError(message) {
                throw new Error(message);
            },
            $: () => null,
            _initPlayer() {
                this._player = { destroy: noop };
            },
            async _startPlayback() {},
            _playNextItem() {
                calls.next++;
            },
            _playPreviousItem() {
                calls.previous++;
            },
            _showLockIndicator() {
                calls.lockIndicator++;
            }
        });
        await page.onInit();
        return { page, calls };
    }

    /** Back: _stopAndExit() navigates away and the router destroys the page */
    function leave(page) {
        page._isExiting = true;
        page.destroy();
    }

    return { bus, added, commands, tvVolume, openPage, leave };
}

test('PlayerPage: destroy() removes every listener the page added to the event bus', async () => {
    const { bus, added, openPage, leave } = createSession();
    const { page } = await openPage('movie');
    assert.ok(added.has('remote:next') && added.has('key:channelUp'), 'the remote control handlers were not added');

    leave(page);

    const left = [...added].filter((event) => bus.listenerCount(event) > 0);
    assert.deepStrictEqual(left, [], 'listeners of a closed player page are still on the event bus');
});

test('PlayerPage: a closed player page no longer handles remote control commands', async () => {
    const { bus, commands, tvVolume, openPage, leave } = createSession();
    const { page, calls } = await openPage('movie');
    leave(page);

    bus.emit('remote:next');
    bus.emit('remote:volumeup');

    assert.strictEqual(calls.next, 0, 'Next from the Jellyfin app ran on a closed player page');
    assert.strictEqual(tvVolume.steps, 0, 'Volume Up from the Jellyfin app changed the TV volume for a closed page');
    assert.deepStrictEqual(commands, []);
});

test('PlayerPage: after an earlier playback, one Next from the Jellyfin app plays the next item once', async () => {
    const { bus, commands, openPage, leave } = createSession();
    const first = await openPage('episode-1');
    leave(first.page);
    const second = await openPage('episode-5');

    bus.emit('remote:next');

    assert.strictEqual(first.calls.next, 0, 'the closed player page advanced the play queue too');
    assert.strictEqual(second.calls.next, 1);
    assert.deepStrictEqual(commands, ['Remote: NextTrack']);
});

test('PlayerPage: while the screen is locked, Next from the Jellyfin app is ignored and shows the lock', async () => {
    const { bus, openPage, leave } = createSession();
    const first = await openPage('episode-1');
    leave(first.page);
    const second = await openPage('episode-5');
    second.page._isScreenLocked = true;

    bus.emit('remote:next');

    assert.strictEqual(first.calls.next, 0, 'the closed player page advanced the play queue past the lock');
    assert.strictEqual(second.calls.next, 0);
    assert.strictEqual(second.calls.lockIndicator, 1);

    // The profile selection on resume blocks remote control commands too, without the lock indicator
    second.page._isScreenLocked = false;
    second.page._resumeProfileSelectionActive = true;
    bus.emit('remote:next');

    assert.strictEqual(first.calls.next, 0);
    assert.strictEqual(second.calls.next, 0);
    assert.strictEqual(second.calls.lockIndicator, 1);
});
