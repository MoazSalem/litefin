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
globalThis.screen = { width: 1920, height: 1080 };
globalThis.window = globalThis;

// Import AndroidProfile and clearCapabilitiesCache
const AndroidProfile = await import('../src/api/profiles/AndroidProfile.js');

// ============================================================================
// Test Suite: AndroidProfile Transcoding Video Codecs
// ============================================================================
// Verifies that video transcoding fallback profiles dynamically adapt to
// hardware capabilities detected on Android devices.
// ============================================================================
test('AndroidProfile: excludes AV1 from TranscodingProfiles when hardware lacks AV1 decoder', () => {
    // Mock native Android interface with AV1 disabled (e.g. Amlogic S905X on Android 9)
    globalThis.LitefinAndroid = {
        getSupportedVideoCodecs: () => JSON.stringify({
            h264: true,
            hevc: true,
            vp9: true,
            vp8: true,
            av1: false,
            mpeg2video: true
        })
    };

    // Invalidate cached capabilities
    AndroidProfile.clearCapabilitiesCache();

    // Build the Jellyfin device profile
    const profile = AndroidProfile.buildJellyfinProfile();

    // Verify DirectPlay does not contain AV1
    const directPlayVideo = profile.DirectPlayProfiles.find(p => p.Type === 'Video');
    assert.ok(directPlayVideo, 'DirectPlay video profile must exist');
    assert.strictEqual(directPlayVideo.VideoCodec.includes('av1'), false, 'DirectPlay must not advertise AV1');

    // Verify TranscodingProfiles does not contain AV1 in any profile
    const mp4Transcode = profile.TranscodingProfiles.find(p => p.Container === 'mp4' && p.Type === 'Video');
    assert.ok(mp4Transcode, 'MP4 HLS transcoding profile must exist');
    assert.strictEqual(mp4Transcode.VideoCodec.includes('av1'), false, 'TranscodingProfiles must not advertise AV1 when unsupported');

    // TS profile must never contain AV1 or VP9
    const tsTranscode = profile.TranscodingProfiles.find(p => p.Container === 'ts' && p.Type === 'Video');
    assert.ok(tsTranscode, 'TS HLS transcoding profile must exist');
    assert.strictEqual(tsTranscode.VideoCodec.includes('av1'), false, 'TS profile must not contain AV1');
    assert.strictEqual(tsTranscode.VideoCodec.includes('vp9'), false, 'TS profile must not contain VP9');
});

test('AndroidProfile: includes AV1 in MP4 TranscodingProfiles when hardware supports AV1', () => {
    // Mock native Android interface on modern devices with hardware AV1 support
    globalThis.LitefinAndroid = {
        getSupportedVideoCodecs: () => JSON.stringify({
            h264: true,
            hevc: true,
            vp9: true,
            vp8: true,
            av1: true,
            mpeg2video: true
        })
    };

    // Invalidate cached capabilities
    AndroidProfile.clearCapabilitiesCache();

    // Build profile with AV1 support active
    const profile = AndroidProfile.buildJellyfinProfile();

    // MP4 container should advertise AV1 for stream-copy remuxing
    const mp4Transcode = profile.TranscodingProfiles.find(p => p.Container === 'mp4' && p.Type === 'Video');
    assert.ok(mp4Transcode, 'MP4 HLS transcoding profile must exist');
    assert.strictEqual(mp4Transcode.VideoCodec.includes('av1'), true, 'TranscodingProfiles must advertise AV1 when hardware supported');
});

test('AndroidProfile: forces H264 transcode video codec when playbackMode is transcodeVideo', () => {
    // Mock hardware with full codec support
    globalThis.LitefinAndroid = {
        getSupportedVideoCodecs: () => JSON.stringify({
            h264: true,
            hevc: true,
            vp9: true,
            vp8: true,
            av1: true,
            mpeg2video: true
        })
    };

    // Invalidate cached capabilities
    AndroidProfile.clearCapabilitiesCache();

    // Build profile in forced video transcode mode
    const profile = AndroidProfile.buildJellyfinProfile({ playbackMode: 'transcodeVideo' });

    // Video transcode profile must strictly be H.264
    const mp4Transcode = profile.TranscodingProfiles.find(p => p.Container === 'mp4' && p.Type === 'Video');
    assert.strictEqual(mp4Transcode.VideoCodec, 'h264', 'transcodeVideo mode must restrict VideoCodec to h264');
});
