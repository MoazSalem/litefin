import assert from 'node:assert/strict';
import test from 'node:test';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
// Set up standard browser global mocks so AndroidProfile and PlayerSettings
// can initialize without a browser runtime environment.
// ============================================================================
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

// Mock standard screen dimensions
globalThis.screen = { width: 3840, height: 2160 };
globalThis.window = globalThis;

// Import AndroidProfile and PlayerSettings
const AndroidProfile = await import('../src/api/profiles/AndroidProfile.js');
const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');

// ============================================================================
// Test Suite: AndroidProfile HDR & Dolby Vision Profile Evaluation
// ============================================================================
test('AndroidProfile: detects HDR10 and Dolby Vision on HDR-capable TV (Shield + LG C6)', () => {
    // Mock native Android interface with HDR10 and Dolby Vision supported
    globalThis.LitefinAndroid = {
        isTv: () => true,
        getDeviceName: () => 'SHIELD Android TV',
        getHdrCapabilities: () => JSON.stringify({
            supported: true,
            hdr10: true,
            hlg: true,
            dolbyVision: true,
            hdr10Plus: false
        }),
        getSupportedVideoCodecs: () => JSON.stringify({
            h264: true,
            hevc: true,
            vp9: true,
            vp8: true,
            av1: false,
            mpeg2video: true
        })
    };

    AndroidProfile.clearCapabilitiesCache();
    const caps = AndroidProfile.getDeviceCapabilities();

    assert.strictEqual(caps.hdr10, true, 'HDR10 must be detected as supported');
    assert.strictEqual(caps.hlg, true, 'HLG must be detected as supported');
    assert.strictEqual(caps.dolbyVision, true, 'Dolby Vision must be detected as supported');

    // Default settings: both HDR and Dolby Vision enabled
    PlayerSettings.set('enableHDR', 'auto');
    PlayerSettings.set('enableDolbyVision', 'auto');

    const profile = AndroidProfile.buildJellyfinProfile();
    const hevcProfile = profile.CodecProfiles.find(p => p.Codec === 'hevc');
    assert.ok(hevcProfile, 'HEVC CodecProfile must exist');

    const rangeCondition = hevcProfile.Conditions.find(c => c.Property === 'VideoRangeType');
    assert.ok(rangeCondition, 'VideoRangeType condition must exist on HEVC');
    assert.ok(rangeCondition.Value.includes('HDR10'), 'Range condition must include HDR10');
    assert.ok(rangeCondition.Value.includes('DOVI'), 'Range condition must include raw DOVI when DV is supported');
    assert.ok(rangeCondition.Value.includes('DOVIWithHDR10'), 'Range condition must include DOVIWithHDR10');
});

test('AndroidProfile: excludes raw DOVI on TV without Dolby Vision support (Samsung TV)', () => {
    // Mock native Android interface on Google TV Streamer connected to Samsung TV
    globalThis.LitefinAndroid = {
        isTv: () => true,
        getDeviceName: () => 'Google TV Streamer',
        getHdrCapabilities: () => JSON.stringify({
            supported: true,
            hdr10: true,
            hlg: true,
            dolbyVision: false,
            hdr10Plus: true
        }),
        getSupportedVideoCodecs: () => JSON.stringify({
            h264: true,
            hevc: true,
            vp9: true,
            vp8: true,
            av1: true,
            mpeg2video: true
        })
    };

    AndroidProfile.clearCapabilitiesCache();
    const caps = AndroidProfile.getDeviceCapabilities();

    assert.strictEqual(caps.hdr10, true, 'HDR10 must be detected as supported');
    assert.strictEqual(caps.dolbyVision, false, 'Dolby Vision must be detected as unsupported on Samsung TV');

    PlayerSettings.set('enableHDR', 'auto');
    PlayerSettings.set('enableDolbyVision', 'auto');

    const profile = AndroidProfile.buildJellyfinProfile();
    const hevcProfile = profile.CodecProfiles.find(p => p.Codec === 'hevc');
    const rangeCondition = hevcProfile.Conditions.find(c => c.Property === 'VideoRangeType');

    assert.ok(rangeCondition, 'VideoRangeType condition must exist');
    assert.ok(rangeCondition.Value.includes('HDR10'), 'Range condition must include HDR10');
    assert.ok(rangeCondition.Value.includes('DOVIWithHDR10'), 'Range condition must include DOVIWithHDR10 fallback layer');
    // Ensure raw 'DOVI' is NOT present as an allowed standalone token
    const tokens = rangeCondition.Value.split('|');
    assert.strictEqual(tokens.includes('DOVI'), false, 'Raw DOVI (Profile 5) must not be permitted on display without Dolby Vision');
});

test('AndroidProfile: user force disable HDR restricts VideoRangeType to SDR', () => {
    globalThis.LitefinAndroid = {
        isTv: () => true,
        getHdrCapabilities: () => JSON.stringify({
            supported: true,
            hdr10: true,
            hlg: true,
            dolbyVision: true,
            hdr10Plus: false
        }),
        getSupportedVideoCodecs: () => JSON.stringify({
            h264: true,
            hevc: true,
            vp9: true,
            vp8: true,
            av1: false,
            mpeg2video: true
        })
    };

    AndroidProfile.clearCapabilitiesCache();

    // User explicitly forces HDR disabled in Settings
    PlayerSettings.set('enableHDR', 'disable');
    PlayerSettings.set('enableDolbyVision', 'disable');

    const profile = AndroidProfile.buildJellyfinProfile();
    const hevcProfile = profile.CodecProfiles.find(p => p.Codec === 'hevc');
    const rangeCondition = hevcProfile.Conditions.find(c => c.Property === 'VideoRangeType');

    assert.ok(rangeCondition, 'VideoRangeType condition must exist');
    assert.strictEqual(rangeCondition.Value, 'SDR|DOVIWithSDR', 'Range condition must strictly allow only SDR and DOVIWithSDR');
});

