import assert from 'node:assert/strict';
import test from 'node:test';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
// Set up standard browser global mocks so TizenProfile and PlayerSettings
// can initialize without a browser runtime environment.
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
        value: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/5.0 TV Safari/537.36',
        configurable: true
    });
} catch (e) {
    // Ignore if not configurable
}
globalThis.window = globalThis;

// Import TizenProfile and PlayerSettings modules dynamically
const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const TizenProfile = await import('../src/api/profiles/TizenProfile.js');

// ============================================================================
// Test Suite: Tizen DirectStream & Transcoding HLS Enforcement
// ============================================================================
// Verifies that video streaming transcoding profiles strictly enforce HLS (Protocol: 'hls')
// and never advertise progressive HTTP (Protocol: 'http') video profiles.
// This prevents Tizen AVPlay seek failure (PLAYER_ERROR_INVALID_STATE) and
// FFmpeg input-seeking A/V sync drift on resume.
// ============================================================================

test('TizenProfile: never advertises progressive HTTP video transcoding profiles', () => {
    // Check multiple playback modes: auto, remux, transcode, directPlay
    const modes = ['auto', 'remux', 'transcode', 'directPlay'];

    for (const mode of modes) {
        // Build the device profile for this mode
        const profile = TizenProfile.buildJellyfinProfile({ playbackMode: mode, backend: 'avplay' });

        // Identify any video streaming profile using HTTP protocol
        const httpVideoProfiles = profile.TranscodingProfiles.filter(
            (p) => p.Type === 'Video' && p.Protocol === 'http' && p.Context === 'Streaming'
        );

        // Verify zero HTTP video streaming profiles exist
        assert.strictEqual(
            httpVideoProfiles.length,
            0,
            `Playback mode '${mode}' must not contain any progressive HTTP video transcoding profiles`
        );

        // Verify all video streaming profiles strictly use HLS
        const videoStreamingProfiles = profile.TranscodingProfiles.filter(
            (p) => p.Type === 'Video' && p.Context === 'Streaming'
        );
        for (const vp of videoStreamingProfiles) {
            assert.strictEqual(
                vp.Protocol,
                'hls',
                `All video streaming profiles in mode '${mode}' must use Protocol 'hls' (found: ${vp.Protocol})`
            );
        }
    }
});

test('TizenProfile: omits DirectStreamProfiles in remux and transcode modes to force HLS delivery', () => {
    // In remux and transcode modes, DirectStreamProfiles should be empty to ensure
    // the server falls through to HLS TranscodingProfiles (master.m3u8)
    const remuxProfile = TizenProfile.buildJellyfinProfile({ playbackMode: 'remux', backend: 'avplay' });
    assert.deepStrictEqual(
        remuxProfile.DirectStreamProfiles,
        [],
        'DirectStreamProfiles must be empty in remux mode so the server serves HLS master.m3u8'
    );

    const transcodeProfile = TizenProfile.buildJellyfinProfile({ playbackMode: 'transcode', backend: 'avplay' });
    assert.deepStrictEqual(
        transcodeProfile.DirectStreamProfiles,
        [],
        'DirectStreamProfiles must be empty in transcode mode so the server serves HLS master.m3u8'
    );
});

test('TizenProfile: includes HEVC in MPEG-TS HLS transcode video codecs when device supports HEVC', () => {
    // When HEVC hardware decoding is supported, the MPEG-TS HLS profile must include
    // 'hevc' so HEVC sources can DirectStream (copy video) without transcoding to H.264
    const profile = TizenProfile.buildJellyfinProfile({ backend: 'avplay' });

    // Locate primary MPEG-TS video streaming profile
    const tsProfile = profile.TranscodingProfiles.find(
        (p) => p.Type === 'Video' && p.Container === 'ts' && p.Protocol === 'hls'
    );

    assert.ok(tsProfile, 'Primary TS HLS transcoding profile must exist');
    const videoCodecs = tsProfile.VideoCodec.split(',');

    // Ensure hevc is included in the TS profile's video codecs
    assert.ok(
        videoCodecs.includes('hevc'),
        'TS HLS profile must include HEVC so HEVC videos DirectStream without re-encoding to H.264'
    );
});
