import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * ============================================================================
 * Prewarm Manager Cache Invalidation Test Suite
 * ============================================================================
 * Verifies that changing audio or subtitle stream indices inside the player
 * immediately invalidates the PrewarmManager cache so that stale default
 * tracks are not restored on subsequent item launches.
 * ============================================================================
 */

// Load PrewarmManager source code directly with imports and exports stripped to run in isolated VM
const prewarmSource = readFileSync(new URL('../src/player/core/PrewarmManager.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export default .*;\n/gm, '')
    .replace(/^export const .*;\n/gm, '')
    .replace('export class PrewarmManager', 'class PrewarmManager');

function createPrewarmManagerInstance() {
    const context = vm.createContext({
        logger: {
            create: () => ({
                info() {},
                debug() {},
                warn() {},
                error() {}
            })
        },
        api: {},
        PlayerSettings: {
            get: () => true
        },
        buildJellyfinProfile: () => ({}),
        FontLoader: {},
        SubtitleStyles: {},
        platformInfo: {},
        AbortController
    });

    const script = `
        ${prewarmSource}
        new PrewarmManager();
    `;

    return vm.runInContext(script, context);
}

test('PrewarmManager.invalidateCache clears all cached item metadata and parameters', () => {
    // Instantiate an isolated PrewarmManager instance for testing
    const manager = createPrewarmManagerInstance();

    // Populate mock cached state simulating an active prewarmed media item
    manager._cachedItemId = 'test-item-123';
    manager._cachedItem = { Id: 'test-item-123', Name: 'Sample Media' };
    manager._playbackInfoPromise = Promise.resolve({ MediaSources: [{ Id: 'ms-1' }] });
    manager._timestamp = Date.now();
    manager._prewarmParams = {
        mediaSourceId: 'ms-1',
        audioStreamIndex: 1,
        subtitleStreamIndex: 2,
        playbackMode: 'auto'
    };

    // Verify state before invalidation
    assert.strictEqual(manager._cachedItemId, 'test-item-123');
    assert.ok(manager.getPrewarmedItem('test-item-123') !== null);

    // Trigger explicit cache invalidation
    manager.invalidateCache();

    // Verify all cached attributes are reset to clean empty state
    assert.strictEqual(manager._cachedItemId, null, 'cachedItemId should be null');
    assert.strictEqual(manager._cachedItem, null, 'cachedItem should be null');
    assert.strictEqual(manager._playbackInfoPromise, null, 'playbackInfoPromise should be null');
    assert.strictEqual(manager._prewarmParams, null, 'prewarmParams should be null');
    assert.strictEqual(manager._timestamp, 0, 'timestamp should be reset to 0');

    // Verify getPrewarmedItem returns null after invalidation
    assert.strictEqual(manager.getPrewarmedItem('test-item-123'), null, 'getPrewarmedItem should return null');
});

// Load the JellyfinPlayer source code directly with normalized line breaks
const playerSource = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

function setupPlayerTestContext() {
    let invalidateCallCount = 0;

    // Track mock prewarm manager invocations
    const mockPrewarmManager = {
        invalidateCache: () => {
            invalidateCallCount++;
        },
        clear: () => {
            invalidateCallCount++;
        }
    };

    const currentSettings = {
        subtitleBurnIn: 'none',
        awaitTracksBeforePlayback: false
    };

    // Construct isolated context with minimal dependencies needed for track setters
    const context = vm.createContext({
        prewarmManager: mockPrewarmManager,
        PlayerSettings: {
            get: (key) => currentSettings[key]
        },
        PlayerEvent: {
            MEDIA_STREAMS_CHANGE: 'mediastreamschange'
        },
        DeliveryMethod: {
            EMBEDDED_NATIVE: 'embedded_native',
            EXTERNAL_TEXT: 'external_text',
            ASS_CANVAS: 'ass_canvas',
            PGS_BITMAP: 'pgs_bitmap',
            NONE: 'none'
        },
        log: {
            info() {},
            debug() {},
            warn() {},
            error() {}
        },
        isAudioTrackNativelyPlayable: () => true
    });

    // Extract exact method blocks
    const setAudioSource = playerSource.slice(
        playerSource.indexOf('    async setAudioStreamIndex(index) {'),
        playerSource.indexOf('\n    /**\n     * Set subtitle track')
    );

    const setSubtitleSource = playerSource.slice(
        playerSource.indexOf('    async setSubtitleStreamIndex(index) {'),
        playerSource.indexOf('\n    /**\n     * Set subtitle offset')
    );

    const script = `
        class MockPlayer {
            constructor() {
                this._currentAudioStreamIndex = 1;
                this._currentSubtitleStreamIndex = 0;
                this._playSetupInProgress = false;
                this._backendType = 'html5';
                this._backend = {
                    setAudioStreamIndex() {},
                    setSubtitleStreamIndex() {}
                };
                this._subtitleManager = {
                    setPrimaryTrack: async () => 'none'
                };
                this.events = [];
            }

            getAudioTracks() {
                return [{ Index: 1 }, { Index: 2 }];
            }

            getSubtitleTracks() {
                return [{ Index: 0 }, { Index: 1 }];
            }

            _getBackendAudioTracks() {
                return [{ Index: 1 }, { Index: 2 }];
            }

            _getBackendAudioTrackListIndex(index) {
                return index;
            }

            emit(name, data) {
                this.events.push({ name, data });
            }

            ${setAudioSource}

            ${setSubtitleSource}
        }

        new MockPlayer();
    `;

    const player = vm.runInContext(script, context);

    return {
        player,
        getInvalidateCount: () => invalidateCallCount
    };
}

test('changing audio stream index in player invalidates prewarm cache', async () => {
    const { player, getInvalidateCount } = setupPlayerTestContext();

    // Initial audio index is 1
    assert.strictEqual(player._currentAudioStreamIndex, 1);
    assert.strictEqual(getInvalidateCount(), 0);

    // Switch audio track to index 2
    await player.setAudioStreamIndex(2);

    // Verify cache invalidation was triggered once
    assert.strictEqual(getInvalidateCount(), 1, 'Cache invalidation should fire on audio index change');
    assert.strictEqual(player._currentAudioStreamIndex, 2);

    // Selecting the same active audio track should NOT invalidate again
    await player.setAudioStreamIndex(2);
    assert.strictEqual(getInvalidateCount(), 1, 'Duplicate audio track selection should not re-invalidate');
});

test('changing subtitle stream index in player invalidates prewarm cache outside setup', async () => {
    const { player, getInvalidateCount } = setupPlayerTestContext();

    // Initial subtitle index is 0
    assert.strictEqual(player._currentSubtitleStreamIndex, 0);
    assert.strictEqual(getInvalidateCount(), 0);

    // Switch subtitle track to index -1 (off)
    await player.setSubtitleStreamIndex(-1);

    // Verify cache invalidation was triggered once
    assert.strictEqual(getInvalidateCount(), 1, 'Cache invalidation should fire on subtitle index change');
    assert.strictEqual(player._currentSubtitleStreamIndex, -1);

    // Selecting the same active subtitle track should NOT invalidate again
    await player.setSubtitleStreamIndex(-1);
    assert.strictEqual(getInvalidateCount(), 1, 'Duplicate subtitle track selection should not re-invalidate');

    // When play setup is in progress (initial playback start), changing subtitle should NOT invalidate
    player._playSetupInProgress = true;
    await player.setSubtitleStreamIndex(1);
    assert.strictEqual(getInvalidateCount(), 1, 'Setup phase subtitle application must not invalidate cache');
});
