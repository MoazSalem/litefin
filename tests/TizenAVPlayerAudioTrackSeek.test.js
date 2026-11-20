import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('TizenAVPlayer: audio track seek assertion structure and player state', () => {
    const tizenSource = readFileSync(
        new URL('../src/player/core/TizenAVPlayer.js', import.meta.url),
        'utf8'
    );

    // 1. Verify player state storage for active AUDIO track index
    assert.ok(
        tizenSource.includes('this._activeTizenAudioIndex = null;'),
        'TizenAVPlayer must initialize _activeTizenAudioIndex in constructor'
    );
    assert.ok(
        tizenSource.includes('this._pendingAudioTrackReassert = false;'),
        'TizenAVPlayer must initialize _pendingAudioTrackReassert in constructor'
    );
    assert.ok(
        tizenSource.includes('getActiveTizenAudioIndex()'),
        'TizenAVPlayer must provide getActiveTizenAudioIndex() getter'
    );

    // 2. Verify getCurrentStreamInfo logging in seekTo success callback and onbufferingcomplete
    assert.ok(
        tizenSource.includes('[SeekTelemetry] webapis.avplay.getCurrentStreamInfo():'),
        'TizenAVPlayer must log webapis.avplay.getCurrentStreamInfo() in seekTo success callback'
    );
    assert.ok(
        tizenSource.includes('[onbufferingcomplete] webapis.avplay.getCurrentStreamInfo():'),
        'TizenAVPlayer must log webapis.avplay.getCurrentStreamInfo() in onbufferingcomplete'
    );

    // 3. Verify _assertActiveAudioTrack is defined and integrated in seekTo success callback
    assert.ok(
        tizenSource.includes('_assertActiveAudioTrack()'),
        'TizenAVPlayer must define _assertActiveAudioTrack'
    );
    assert.ok(
        tizenSource.includes('this._assertActiveAudioTrack();'),
        'TizenAVPlayer must call _assertActiveAudioTrack in seekTo completion path'
    );

    // 4. Verify re-apply / toggle logic for active track
    assert.ok(
        tizenSource.includes("this._avplay.setSelectTrack('AUDIO', targetIndex);"),
        'TizenAVPlayer must re-assert or re-apply setSelectTrack with active AUDIO track index'
    );
});

test('TizenAVPlayer: audio track re-assertion behavior in simulated environment', async () => {
    globalThis.window = globalThis.window || { innerWidth: 1920, innerHeight: 1080 };
    globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.document = globalThis.document || {
        documentElement: {},
        createElement: () => ({}),
        body: { appendChild() {} }
    };

    const { TizenAVPlayer } = await import('../src/player/core/TizenAVPlayer.js');

    // Create a mock AVPlay instance
    let selectedAudioTrack = null;
    let setSelectTrackCalls = [];
    const mockAvplay = {
        getState: () => 'PLAYING',
        getCurrentTime: () => 10000,
        getCurrentStreamInfo: () => [
            { type: 'VIDEO', index: 0 },
            // AUDIO stream missing or on index 0 while active track is 1
            { type: 'AUDIO', index: 0 }
        ],
        getTotalTrackInfo: () => [
            { type: 'VIDEO', index: 0 },
            { type: 'AUDIO', index: 0 },
            { type: 'AUDIO', index: 1 }
        ],
        setSelectTrack: (type, index) => {
            setSelectTrackCalls.push({ type, index });
            if (type === 'AUDIO') {
                selectedAudioTrack = index;
            }
        },
        seekTo: (ms, successCb) => {
            if (successCb) successCb();
        }
    };

    const player = new TizenAVPlayer({ container: {} });
    player._avplay = mockAvplay;
    player._isPrepared = true;
    player._activeTizenAudioIndex = 1;

    // Call _assertActiveAudioTrack directly
    player._assertActiveAudioTrack();

    // Verify track 1 was re-asserted because getCurrentStreamInfo reported 0
    assert.equal(selectedAudioTrack, 1, 'Audio track should be re-asserted to active track index 1');
    assert.equal(player.getActiveTizenAudioIndex(), 1);

    // Now simulate pipeline stalled while already on index 1: it should toggle or re-apply
    setSelectTrackCalls = [];
    mockAvplay.getCurrentStreamInfo = () => [
        { type: 'VIDEO', index: 0 },
        { type: 'AUDIO', index: 1 }
    ];

    player._assertActiveAudioTrack();
    // In multi-track scenario, it toggles via alternate track 0 then re-applies track 1
    assert.ok(setSelectTrackCalls.some(c => c.type === 'AUDIO' && c.index === 1), 'Track 1 must be re-applied');
    assert.equal(player.getActiveTizenAudioIndex(), 1);
});

test('TizenAVPlayer: cleanup routines cleanly sequence stop/close, reset display rect, detach DOM object, and trigger compositor reset', async () => {
    let stopCalls = 0;
    let closeCalls = 0;
    let setListenerCalls = 0;
    const setDisplayRectCalls = [];
    let layerResets = 0;

    const mockAvplay = {
        getState: () => 'PLAYING',
        setListener: (val) => {
            if (val === null) setListenerCalls++;
        },
        stop: () => {
            stopCalls++;
        },
        setDisplayRect: (...args) => {
            setDisplayRectCalls.push(args);
        },
        close: () => {
            closeCalls++;
        }
    };

    const mockObj = {
        id: 'litefin-avplayer-host',
        parentNode: {
            removeChild: (node) => {
                if (node === mockObj) mockObj.parentNode = null;
            }
        }
    };

    const { TizenAVPlayer } = await import('../src/player/core/TizenAVPlayer.js');
    const player = new TizenAVPlayer({ container: {} });
    player._avplay = mockAvplay;
    player._avplayObjectEl = mockObj;

    const { tizenAdapter } = await import('../src/tizen/TizenAdapter.js');
    const origReset = tizenAdapter.resetCompositorLayer;
    tizenAdapter.resetCompositorLayer = () => {
        layerResets++;
    };

    try {
        await player.stop();

        assert.equal(setListenerCalls, 1, 'setListener(null) must be called to release VRAM references');
        assert.equal(stopCalls, 1, 'stop() must be called');
        assert.deepEqual(setDisplayRectCalls, [[0, 0, 0, 0]], 'setDisplayRect(0, 0, 0, 0) must be called to release video overlay');
        assert.equal(closeCalls, 1, 'close() must be called');
        assert.equal(mockObj.parentNode, null, 'Host node must be unmounted from parent');
        assert.equal(layerResets, 1, 'resetCompositorLayer must be triggered');

        // Verify destroy() also cleans up even if stop() throws
        const failingAvplay = {
            getState: () => 'PLAYING',
            setListener: () => {},
            stop: () => {
                throw new Error('STOP_FAILED');
            },
            setDisplayRect: (...args) => {
                setDisplayRectCalls.push(args);
            },
            close: () => {
                closeCalls++;
            }
        };

        const player2 = new TizenAVPlayer({ container: {} });
        player2._avplay = failingAvplay;
        player2.destroy();

        assert.equal(closeCalls, 2, 'close() must still be called in destroy() when stop() throws');
        assert.deepEqual(setDisplayRectCalls[setDisplayRectCalls.length - 1], [0, 0, 0, 0]);
    } finally {
        tizenAdapter.resetCompositorLayer = origReset;
    }
});
