import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * webOS Keep-Screen Activity Test Suite
 * ============================================================================
 * With "suppress screensaver during playback" on, playback creates a
 * continuous power activity with com.palm.activitymanager and cancels it on
 * pause/stop. Its id only arrives in the create reply, and 'player:playing'
 * fires after every seek and rebuffer. A stop while create is in flight must
 * still cancel the activity (else the screensaver stays off after playback),
 * and no second create may go out meanwhile.
 * The WebOSAdapter methods are taken from the source and run on a stub.
 * ============================================================================
 */

const source = readFileSync(new URL('../src/webos/WebOSAdapter.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function extractMethod(signature) {
    const start = source.indexOf(`\n    ${signature}`);
    if (start === -1) return null;
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };

/** An adapter with suppression enabled, on a TV whose Luna replies arrive when the test says so. */
function createAdapter(window) {
    const context = vm.createContext({
        log: quietLog,
        window,
        JSON,
        storage: { getItem: (key) => (key === 'pref:suppressScreensaverOnPlayback' ? 'true' : null) }
    });
    const methods = vm.runInContext(
        `({\n${[
            'setKeepScreenOn(keepOn = true) {',
            '_createKeepScreenActivity() {',
            '_cancelKeepScreenActivity() {',
            '_callPalmServiceBridge(uri, params, onReply) {'
        ]
            .map(extractMethod)
            .filter(Boolean)
            .join(',\n')}\n})`,
        context
    );
    return Object.assign(Object.create(methods), {
        _isWebOS: true,
        _screenSaverBlocked: false,
        _keepScreenActivityId: null,
        _keepScreenActivityPending: false,
        _isPlaybackKeepOnRequested: false,
        _pendingBridges: [],
        _registerScreenSaverGuard() {}
    });
}

/** webOS.service.request that records calls and holds each reply until released. */
function createLunaService() {
    const calls = [];
    const window = {
        webOS: {
            service: {
                request(uri, { method, parameters, onSuccess }) {
                    calls.push({ method, parameters, reply: (res) => onSuccess(res) });
                }
            }
        }
    };
    return { window, calls };
}

test('webOS keep-screen: a stop while create is in flight still cancels the activity', () => {
    const { window, calls } = createLunaService();
    const adapter = createAdapter(window);

    adapter.setKeepScreenOn(true); // player:play
    adapter.setKeepScreenOn(true); // player:playing, before the create reply
    adapter.setKeepScreenOn(false); // Back
    assert.deepStrictEqual(
        calls.map((c) => c.method),
        ['create'],
        'a second power activity was requested while the first create was in flight'
    );

    calls[0].reply({ returnValue: true, activityId: 41 });

    assert.deepStrictEqual(
        calls.map((c) => `${c.method}${c.parameters.activityId ?? ''}`),
        ['create', 'cancel41'],
        'the activity created for playback that already stopped was never cancelled'
    );
    assert.strictEqual(adapter._keepScreenActivityId, null);
});

test('webOS keep-screen: playback that resumes while create is in flight keeps the activity until the next stop', () => {
    const { window, calls } = createLunaService();
    const adapter = createAdapter(window);

    adapter.setKeepScreenOn(true);
    adapter.setKeepScreenOn(false); // pause
    adapter.setKeepScreenOn(true); // play again, reply still pending
    calls[0].reply({ returnValue: true, activityId: 7 });
    assert.deepStrictEqual(
        calls.map((c) => c.method),
        ['create']
    );
    assert.strictEqual(adapter._keepScreenActivityId, 7);

    adapter.setKeepScreenOn(false);
    assert.deepStrictEqual(
        calls.map((c) => `${c.method}${c.parameters.activityId ?? ''}`),
        ['create', 'cancel7']
    );
});

test('webOS keep-screen: a failed create does not block the next one', () => {
    let creates = 0;
    const adapter = createAdapter({
        webOS: {
            service: {
                request(uri, { method, onFailure }) {
                    if (method === 'create') creates++;
                    onFailure({ returnValue: false, errorText: 'busy' });
                }
            }
        }
    });

    adapter.setKeepScreenOn(true);
    adapter.setKeepScreenOn(true);
    assert.strictEqual(creates, 2);
});

test('webOS keep-screen: PalmServiceBridge calls stay referenced until their reply, and a late create is cancelled', () => {
    const bridges = [];
    class FakeBridge {
        constructor() {
            bridges.push(this);
        }
        call(uri, params) {
            this.uri = uri;
            this.params = JSON.parse(params);
        }
    }
    const adapter = createAdapter({ PalmServiceBridge: FakeBridge });

    adapter.setKeepScreenOn(true);
    adapter.setKeepScreenOn(false);
    assert.strictEqual(bridges.length, 1);
    assert.ok(
        Array.isArray(adapter._pendingBridges) && adapter._pendingBridges.includes(bridges[0]),
        'nothing references the bridge: it can be garbage-collected before its reply'
    );

    bridges[0].onservicecallback(JSON.stringify({ returnValue: true, activityId: 9 }));

    assert.ok(!adapter._pendingBridges.includes(bridges[0]));
    assert.deepStrictEqual(
        bridges.map((b) => `${b.uri.split('/').pop()}${b.params.activityId ?? ''}`),
        ['create', 'cancel9']
    );
    assert.ok(adapter._pendingBridges.includes(bridges[1]), 'cancel bridge not kept until its reply');
});
