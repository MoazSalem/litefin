import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager' },
    configurable: true
});
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080 },
    MediaSource: { isTypeSupported: () => true }
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    createElement: () => ({ canPlayType: () => 'probably', addEventListener() {}, style: {} }),
    body: { appendChild() {} }
};

const { buildJellyfinProfile, clearCapabilitiesCache } = await import('../src/api/profiles/WebOSProfile.js');

test('WebOSProfile: remux and transcodeAudio use valid video codecs, never "copy"', () => {
    clearCapabilitiesCache();

    // 1. Remux mode
    const remuxProfile = buildJellyfinProfile({ playbackMode: 'remux' });
    const remuxHlsProfiles = remuxProfile.TranscodingProfiles.filter((p) => p.Protocol === 'hls' && p.Type === 'Video');
    assert.ok(remuxHlsProfiles.length > 0, 'Must have HLS video transcoding profiles in remux mode');
    for (const p of remuxHlsProfiles) {
        assert.notEqual(p.VideoCodec, 'copy', 'VideoCodec must never be literal "copy" (causes VideoCodecNotSupported on Jellyfin server)');
        assert.ok(p.VideoCodec.includes('h264'), 'VideoCodec must include h264');
    }

    // 2. TranscodeAudio mode
    clearCapabilitiesCache();
    const transAudioProfile = buildJellyfinProfile({ playbackMode: 'transcodeAudio' });
    const transAudioHlsProfiles = transAudioProfile.TranscodingProfiles.filter((p) => p.Protocol === 'hls' && p.Type === 'Video');
    assert.ok(transAudioHlsProfiles.length > 0, 'Must have HLS video transcoding profiles in transcodeAudio mode');
    for (const p of transAudioHlsProfiles) {
        assert.notEqual(p.VideoCodec, 'copy', 'VideoCodec must never be literal "copy"');
        assert.ok(p.VideoCodec.includes('h264'), 'VideoCodec must include h264');
    }
});
