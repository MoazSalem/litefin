import assert from 'node:assert/strict';
import test from 'node:test';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
// Provide the minimal DOM and browser globals needed to cleanly initialize
// device capability probing and player settings in the headless test runner.
// ============================================================================
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

// Mock document for capability element creation
globalThis.document = {
    createElement: () => ({
        canPlayType: () => ''
    })
};

// Mock standard screen dimensions
globalThis.screen = { width: 3840, height: 2160 };

// Simulate an LG WebOS TV user agent (WebOS 3.5 on Chrome 38)
try {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/38.0.2125.122 Safari/537.36 WebAppManager',
        configurable: true
    });
} catch (e) {
    // Ignore if property is already defined
}
globalThis.window = globalThis;

// Dynamic imports after global mock initialization
const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const WebOSProfile = await import('../src/api/profiles/WebOSProfile.js');

// ============================================================================
// WebOS Dolby Vision MKV Profile Tests
// ============================================================================
// Tests that WebOSProfile does not inject container-level VideoRangeType
// negative conditions for MKV that cause Jellyfin's StreamBuilder to emit
// VideoRangeTypeNotSupported and force full 4K SDR transcodes.
// ============================================================================

test('WebOSProfile: does not restrict DOVI in MKV to avoid VideoRangeTypeNotSupported 4K transcode', () => {
    // Enable HDR and Dolby Vision in settings
    PlayerSettings.set('enableHDR', true);
    PlayerSettings.set('enableDolbyVision', true);

    const profile = WebOSProfile.buildJellyfinProfile();

    // 1. DirectPlayProfiles must include MKV with HEVC support
    const mkvDirectPlay = profile.DirectPlayProfiles.find(
        (p) => p.Type === 'Video' && p.Container.split(',').includes('mkv')
    );
    assert.ok(mkvDirectPlay, 'DirectPlayProfiles must include MKV container');
    assert.ok(mkvDirectPlay.VideoCodec.includes('hevc'), 'MKV DirectPlay must support HEVC');

    // 2. Ensure NO CodecProfile exists that restricts MKV by VideoRangeType
    const mkvDoviRestriction = profile.CodecProfiles.find((cp) => {
        const matchesContainer = cp.Container && cp.Container.split(',').includes('mkv');
        const hasRangeCondition = cp.Conditions?.some((c) => c.Property === 'VideoRangeType');
        return matchesContainer && hasRangeCondition;
    });

    assert.equal(
        mkvDoviRestriction,
        undefined,
        'CodecProfiles must not restrict MKV containers with VideoRangeType conditions as Jellyfin evaluates them on source containers'
    );

    // 3. HEVC profile must allow DOVI range types
    const hevcProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'Video' && cp.Codec === 'hevc'
    );
    assert.ok(hevcProfile, 'HEVC CodecProfile must exist');

    const rangeCondition = hevcProfile.Conditions.find((c) => c.Property === 'VideoRangeType');
    assert.ok(rangeCondition, 'HEVC profile must have a VideoRangeType condition');
    assert.ok(rangeCondition.Value.includes('DOVIWithHDR10'), 'HEVC profile must permit DOVIWithHDR10');
    assert.ok(rangeCondition.Value.includes('DOVIWithHDR10Plus'), 'HEVC profile must permit DOVIWithHDR10Plus');
    assert.ok(rangeCondition.Value.includes('DOVI'), 'HEVC profile must permit DOVI when enableDolbyVision is true');
});

test('WebOSProfile: preserves HDR10 fallback for Profile 8 when Dolby Vision is disabled', () => {
    // Enable HDR but disable Dolby Vision
    PlayerSettings.set('enableHDR', true);
    PlayerSettings.set('enableDolbyVision', false);

    const profile = WebOSProfile.buildJellyfinProfile();

    // Locate HEVC CodecProfile
    const hevcProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'Video' && cp.Codec === 'hevc'
    );
    assert.ok(hevcProfile, 'HEVC CodecProfile must exist');

    const rangeCondition = hevcProfile.Conditions.find((c) => c.Property === 'VideoRangeType');
    assert.ok(rangeCondition, 'HEVC profile must have a VideoRangeType condition');

    // Profile 8 with HDR10/HDR10+ fallback should be permitted so the TV direct-plays the base layer
    assert.ok(rangeCondition.Value.includes('DOVIWithHDR10'), 'DOVIWithHDR10 should be accepted for base layer playback');
    assert.ok(rangeCondition.Value.includes('DOVIWithHDR10Plus'), 'DOVIWithHDR10Plus should be accepted for base layer playback');

    // Profile 5 without fallback layer must be excluded so Jellyfin properly tone-maps it to SDR
    const allowedRanges = rangeCondition.Value.split('|');
    assert.ok(!allowedRanges.includes('DOVI'), 'Raw DOVI (Profile 5) must be excluded when enableDolbyVision is false');
});
