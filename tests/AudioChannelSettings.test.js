import assert from 'node:assert/strict';
import test from 'node:test';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
// Polyfill minimal browser DOM globals so that capability detection routines
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
        canPlayType: () => ''
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
// Audio Channel Configuration Isolation Tests
// ============================================================================
// Tests that Direct Play max audio channels (allowedAudioChannels) and
// Transcode max audio channels (transcodeMaxAudioChannels) operate
// independently across device profile generators (Tizen, WebOS, Web).
// ============================================================================

test('TizenProfile: differentiates Direct Play channel cap from Transcode output channel cap', () => {
    // -------------------------------------------------------------------------
    // Setup: User allows 5.1 (6 channels) for Direct Play,
    // but forces Transcoded audio to downmix to Stereo (2 channels).
    // -------------------------------------------------------------------------
    PlayerSettings.set('allowedAudioChannels', 6);
    PlayerSettings.set('transcodeMaxAudioChannels', 2);

    const profile = TizenProfile.buildJellyfinProfile();

    // 1. Verify Direct Play qualification conditions in CodecProfiles
    const videoAudioProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'VideoAudio' && cp.Conditions?.some((c) => c.Property === 'AudioChannels')
    );
    assert.ok(videoAudioProfile, 'VideoAudio codec profile condition must exist');
    const directCondition = videoAudioProfile.Conditions.find((c) => c.Property === 'AudioChannels');
    assert.strictEqual(directCondition.Value, '6', 'Direct play condition must reflect allowedAudioChannels (6)');

    // 2. Verify Transcode output channel cap in TranscodingProfiles
    const hlsTranscodeProfile = profile.TranscodingProfiles.find(
        (tp) => tp.Type === 'Video' && tp.Protocol === 'hls' && tp.MaxAudioChannels !== undefined
    );
    assert.ok(hlsTranscodeProfile, 'HLS video transcoding profile must exist');
    assert.strictEqual(hlsTranscodeProfile.MaxAudioChannels, 2, 'Transcoding profile MaxAudioChannels must reflect transcodeMaxAudioChannels (2)');

    // Reset settings
    PlayerSettings.set('allowedAudioChannels', -1);
    PlayerSettings.set('transcodeMaxAudioChannels', -1);
});

test('WebOSProfile: transcodeMaxAudioChannels defaults to allowedAudioChannels when auto (-1)', () => {
    // -------------------------------------------------------------------------
    // Setup: Direct Play is capped at 5.1 (6), transcodeMaxAudioChannels is Auto (-1)
    // -------------------------------------------------------------------------
    PlayerSettings.set('allowedAudioChannels', 6);
    PlayerSettings.set('transcodeMaxAudioChannels', -1);

    const profile = WebOSProfile.buildJellyfinProfile();

    // 1. Verify CodecProfiles contains 6
    const videoAudioProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'VideoAudio' && cp.Conditions?.some((c) => c.Property === 'AudioChannels')
    );
    assert.ok(videoAudioProfile, 'VideoAudio profile condition must exist');
    const directCondition = videoAudioProfile.Conditions.find((c) => c.Property === 'AudioChannels');
    assert.strictEqual(directCondition.Value, '6');

    // 2. Verify TranscodingProfiles inherits the 6 from allowedAudioChannels
    const hlsProfile = profile.TranscodingProfiles.find((tp) => tp.Type === 'Video' && tp.Protocol === 'hls');
    assert.ok(hlsProfile, 'HLS transcoding profile must exist');
    assert.strictEqual(hlsProfile.MaxAudioChannels, 6, 'Transcode profile must fall back to allowedAudioChannels when auto');

    // Reset settings
    PlayerSettings.set('allowedAudioChannels', -1);
    PlayerSettings.set('transcodeMaxAudioChannels', -1);
});

test('WebProfile: transcodeMaxAudioChannels applies independently to HLS profiles', () => {
    // -------------------------------------------------------------------------
    // Setup: Direct play capped at 8 (7.1), transcode capped at 6 (5.1)
    // -------------------------------------------------------------------------
    PlayerSettings.set('allowedAudioChannels', 8);
    PlayerSettings.set('transcodeMaxAudioChannels', 6);

    const profile = WebProfile.buildJellyfinProfile();

    const videoAudioProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'VideoAudio' && cp.Conditions?.some((c) => c.Property === 'AudioChannels')
    );
    const directCondition = videoAudioProfile.Conditions.find((c) => c.Property === 'AudioChannels');
    assert.strictEqual(directCondition.Value, '8', 'Direct play condition must be 8');

    const hlsProfile = profile.TranscodingProfiles.find((tp) => tp.Type === 'Video' && tp.Protocol === 'hls');
    assert.strictEqual(hlsProfile.MaxAudioChannels, '6', 'Transcode MaxAudioChannels must be 6');

    // Reset settings
    PlayerSettings.set('allowedAudioChannels', -1);
    PlayerSettings.set('transcodeMaxAudioChannels', -1);
});
