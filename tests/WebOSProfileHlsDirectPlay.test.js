import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * WebOS Device Profile — HLS DirectPlayProfile Test Suite
 * ============================================================================
 * Verifies that WebOSProfile advertises Container: 'hls' in DirectPlayProfiles
 * for both the native webOS backend and the HTML5 fallback backend, and omits
 * it when a forced server-processing playbackMode is active.
 * ============================================================================
 */

// Minimal browser globals required by WebOSProfile capability probing
Object.defineProperty(globalThis, 'navigator', {
    value: {
        userAgent:
            'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager'
    },
    configurable: true
});
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080 },
    MediaSource: { isTypeSupported: () => true }
};
globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    key: () => null,
    length: 0
};
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    createElement: () => ({ canPlayType: () => 'probably', addEventListener() {}, style: {} }),
    body: { appendChild() {} }
};

const { buildJellyfinProfile, clearCapabilitiesCache } = await import('../src/api/profiles/WebOSProfile.js');

test('WebOSProfile includes HLS Video DirectPlayProfile for native and html5 backends', () => {
    for (const backend of ['webos', 'html5']) {
        clearCapabilitiesCache();
        const profile = buildJellyfinProfile({ backend });

        // Locate the HLS DirectPlay entry for video streams
        const hlsDirectPlay = profile.DirectPlayProfiles.find(
            (p) => p.Type === 'Video' && p.Container === 'hls'
        );

        assert.ok(hlsDirectPlay, `Expected Container: 'hls' DirectPlayProfile for ${backend} backend`);
        assert.ok(hlsDirectPlay.VideoCodec.split(',').includes('h264'), 'HLS DirectPlayProfile must include h264');
        assert.ok(hlsDirectPlay.AudioCodec.split(',').includes('aac'), 'HLS DirectPlayProfile must include aac');
    }
});

test('WebOSProfile omits HLS DirectPlayProfile in forced transcode/remux modes', () => {
    for (const playbackMode of ['transcode', 'remux', 'transcodeVideo', 'transcodeAudio']) {
        clearCapabilitiesCache();
        const profile = buildJellyfinProfile({ playbackMode });

        // Forced server-processing modes must keep DirectPlayProfiles empty
        const hlsDirectPlay = profile.DirectPlayProfiles.find((p) => p.Container === 'hls');
        assert.equal(hlsDirectPlay, undefined, `HLS DirectPlayProfile must be omitted in ${playbackMode} mode`);
    }
});
