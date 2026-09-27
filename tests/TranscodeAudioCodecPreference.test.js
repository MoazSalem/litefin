import assert from 'node:assert/strict';
import test from 'node:test';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
// Polyfill minimal browser DOM globals so capability detection routines
// (document.createElement, screen, navigator, localStorage) initialize cleanly.
// ============================================================================
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

globalThis.document = {
    createElement: () => ({
        canPlayType: () => 'probably'
    })
};

globalThis.screen = { width: 1920, height: 1080 };
try {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (SmartHub; SMART-TV; U; Linux/Tizen)',
        configurable: true
    });
} catch (e) {
    // Ignore if already set or not configurable
}
globalThis.window = globalThis;

// Dynamic imports after environment globals are ready
const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const TizenProfile = await import('../src/api/profiles/TizenProfile.js');
const WebOSProfile = await import('../src/api/profiles/WebOSProfile.js');
const WebProfile = await import('../src/api/profiles/WebProfile.js');

// ============================================================================
// Helper: Extract Video Streaming Transcode Audio Codecs
// ============================================================================
// Retrieves the distinct list of audio codecs advertised across Video Streaming
// TranscodingProfiles (e.g. HLS video profiles).
// ============================================================================
function getVideoTranscodeAudioCodecs(profile) {
    // Filter profiles that represent video streaming targets
    const videoTranscodeProfiles = profile.TranscodingProfiles.filter(
        (p) => p.Type === 'Video' && p.Context === 'Streaming'
    );
    // Return array of distinct AudioCodec values
    return Array.from(new Set(videoTranscodeProfiles.map((p) => p.AudioCodec)));
}

// ============================================================================
// Test Suite: Preferred Transcode Audio Codec Setting Resolution
// ============================================================================

test('prefer_aac: advertises AAC and never includes EAC3 or AC3 in video transcoding profiles', () => {
    // Set user preference to prefer_aac
    PlayerSettings.set('transcodeAudioCodec', 'prefer_aac');

    // 1. Tizen Profile
    const tizenProfile = TizenProfile.buildJellyfinProfile();
    const tizenCodecs = getVideoTranscodeAudioCodecs(tizenProfile);
    // AAC must be the first/primary transcode target
    assert.strictEqual(tizenCodecs[0], 'aac', 'Tizen: AAC must be the primary transcode codec');
    // EAC3 and AC3 must NOT be present in transcoding profiles
    assert.ok(!tizenCodecs.includes('eac3'), 'Tizen: EAC3 must not be present when prefer_aac is selected');
    assert.ok(!tizenCodecs.includes('ac3'), 'Tizen: AC3 must not be present when prefer_aac is selected');

    // 2. WebOS Profile
    const webosProfile = WebOSProfile.buildJellyfinProfile();
    const webosCodecs = getVideoTranscodeAudioCodecs(webosProfile);
    // WebOS must also prioritize AAC and omit EAC3/AC3
    assert.strictEqual(webosCodecs[0], 'aac', 'WebOS: AAC must be the primary transcode codec');
    assert.ok(!webosCodecs.includes('eac3'), 'WebOS: EAC3 must not be present when prefer_aac is selected');
    assert.ok(!webosCodecs.includes('ac3'), 'WebOS: AC3 must not be present when prefer_aac is selected');

    // 3. Web Profile
    const webProfile = WebProfile.buildJellyfinProfile();
    const webCodecs = getVideoTranscodeAudioCodecs(webProfile);
    // Web browser profile must prioritize AAC and omit EAC3/AC3
    assert.strictEqual(webCodecs[0], 'aac', 'Web: AAC must be the primary transcode codec');
    assert.ok(!webCodecs.includes('eac3'), 'Web: EAC3 must not be present when prefer_aac is selected');
    assert.ok(!webCodecs.includes('ac3'), 'Web: AC3 must not be present when prefer_aac is selected');
});

test('prefer_ac3: advertises AC3 with AAC fallback and never includes EAC3', () => {
    // Set user preference to prefer_ac3 (with AAC fallback)
    PlayerSettings.set('transcodeAudioCodec', 'prefer_ac3');

    // 1. Tizen Profile
    const tizenProfile = TizenProfile.buildJellyfinProfile();
    const tizenCodecs = getVideoTranscodeAudioCodecs(tizenProfile);
    // AC3 must be primary, AAC must be fallback, EAC3 must be excluded
    assert.strictEqual(tizenCodecs[0], 'ac3', 'Tizen: AC3 must be the primary transcode codec');
    assert.ok(tizenCodecs.includes('aac'), 'Tizen: AAC fallback must be present');
    assert.ok(!tizenCodecs.includes('eac3'), 'Tizen: EAC3 must not be present when prefer_ac3 is selected');

    // 2. WebOS Profile
    const webosProfile = WebOSProfile.buildJellyfinProfile();
    const webosCodecs = getVideoTranscodeAudioCodecs(webosProfile);
    // WebOS AC3 first with AAC fallback and no EAC3
    assert.strictEqual(webosCodecs[0], 'ac3', 'WebOS: AC3 must be the primary transcode codec');
    assert.ok(webosCodecs.includes('aac'), 'WebOS: AAC fallback must be present');
    assert.ok(!webosCodecs.includes('eac3'), 'WebOS: EAC3 must not be present when prefer_ac3 is selected');

    // 3. Web Profile
    const webProfile = WebProfile.buildJellyfinProfile();
    const webCodecs = getVideoTranscodeAudioCodecs(webProfile);
    // Web profile AC3 first with AAC fallback and no EAC3
    assert.strictEqual(webCodecs[0], 'ac3', 'Web: AC3 must be the primary transcode codec');
    assert.ok(webCodecs.includes('aac'), 'Web: AAC fallback must be present');
    assert.ok(!webCodecs.includes('eac3'), 'Web: EAC3 must not be present when prefer_ac3 is selected');
});

test('auto: advertises EAC3 first (when supported) followed by AC3 and AAC fallback', () => {
    // Reset to auto mode
    PlayerSettings.set('transcodeAudioCodec', 'auto');

    // 1. WebOS Profile (EAC3 probe supported)
    const webosProfile = WebOSProfile.buildJellyfinProfile();
    const webosCodecs = getVideoTranscodeAudioCodecs(webosProfile);
    // Auto should include EAC3 first, then AC3, then AAC
    assert.strictEqual(webosCodecs[0], 'eac3', 'WebOS: EAC3 must be primary in auto mode when supported');
    assert.ok(webosCodecs.includes('ac3'), 'WebOS: AC3 must be included in auto mode');
    assert.ok(webosCodecs.includes('aac'), 'WebOS: AAC must be included in auto mode');

    // 2. Web Profile
    const webProfile = WebProfile.buildJellyfinProfile();
    const webCodecs = getVideoTranscodeAudioCodecs(webProfile);
    // Web profile in auto mode
    assert.strictEqual(webCodecs[0], 'eac3', 'Web: EAC3 must be primary in auto mode when supported');
    assert.ok(webCodecs.includes('ac3'), 'Web: AC3 must be included in auto mode');
    assert.ok(webCodecs.includes('aac'), 'Web: AAC must be included in auto mode');
});

test('forced codec modes: advertise exclusively the requested codec', () => {
    // -------------------------------------------------------------------------
    // Test force_eac3
    // -------------------------------------------------------------------------
    PlayerSettings.set('transcodeAudioCodec', 'force_eac3');
    const tizenEac3 = getVideoTranscodeAudioCodecs(TizenProfile.buildJellyfinProfile());
    const webosEac3 = getVideoTranscodeAudioCodecs(WebOSProfile.buildJellyfinProfile());
    const webEac3 = getVideoTranscodeAudioCodecs(WebProfile.buildJellyfinProfile());
    // All profiles must only advertise eac3
    assert.deepStrictEqual(tizenEac3, ['eac3'], 'Tizen force_eac3 must contain only eac3');
    assert.deepStrictEqual(webosEac3, ['eac3'], 'WebOS force_eac3 must contain only eac3');
    assert.deepStrictEqual(webEac3, ['eac3'], 'Web force_eac3 must contain only eac3');

    // -------------------------------------------------------------------------
    // Test force_ac3
    // -------------------------------------------------------------------------
    PlayerSettings.set('transcodeAudioCodec', 'force_ac3');
    const tizenAc3 = getVideoTranscodeAudioCodecs(TizenProfile.buildJellyfinProfile());
    const webosAc3 = getVideoTranscodeAudioCodecs(WebOSProfile.buildJellyfinProfile());
    const webAc3 = getVideoTranscodeAudioCodecs(WebProfile.buildJellyfinProfile());
    // All profiles must only advertise ac3
    assert.deepStrictEqual(tizenAc3, ['ac3'], 'Tizen force_ac3 must contain only ac3');
    assert.deepStrictEqual(webosAc3, ['ac3'], 'WebOS force_ac3 must contain only ac3');
    assert.deepStrictEqual(webAc3, ['ac3'], 'Web force_ac3 must contain only ac3');

    // -------------------------------------------------------------------------
    // Test force_aac
    // -------------------------------------------------------------------------
    PlayerSettings.set('transcodeAudioCodec', 'force_aac');
    const tizenAac = getVideoTranscodeAudioCodecs(TizenProfile.buildJellyfinProfile());
    const webosAac = getVideoTranscodeAudioCodecs(WebOSProfile.buildJellyfinProfile());
    const webAac = getVideoTranscodeAudioCodecs(WebProfile.buildJellyfinProfile());
    // All profiles must only advertise aac
    assert.deepStrictEqual(tizenAac, ['aac'], 'Tizen force_aac must contain only aac');
    assert.deepStrictEqual(webosAac, ['aac'], 'WebOS force_aac must contain only aac');
    assert.deepStrictEqual(webAac, ['aac'], 'Web force_aac must contain only aac');

    // -------------------------------------------------------------------------
    // Test force_mp3
    // -------------------------------------------------------------------------
    PlayerSettings.set('transcodeAudioCodec', 'force_mp3');
    const tizenMp3 = getVideoTranscodeAudioCodecs(TizenProfile.buildJellyfinProfile());
    const webosMp3 = getVideoTranscodeAudioCodecs(WebOSProfile.buildJellyfinProfile());
    const webMp3 = getVideoTranscodeAudioCodecs(WebProfile.buildJellyfinProfile());
    // All profiles must only advertise mp3
    assert.deepStrictEqual(tizenMp3, ['mp3'], 'Tizen force_mp3 must contain only mp3');
    assert.deepStrictEqual(webosMp3, ['mp3'], 'WebOS force_mp3 must contain only mp3');
    assert.deepStrictEqual(webMp3, ['mp3'], 'Web force_mp3 must contain only mp3');
});
