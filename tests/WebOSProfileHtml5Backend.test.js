import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Device Profile — HTML5 Backend Test Suite
 * ============================================================================
 * On webOS the HTML5 backend ("Retry with HTML5", or the backend setting)
 * plays HLS through hls.js + MSE instead of the TV's native pipeline, so its
 * profile must not ask the server for what hls.js / MSE cannot play:
 * E-AC-3 in MPEG-TS, Dolby Vision, and AC-3 / HEVC where MSE lacks them.
 * The native webOS backend profile is unchanged.
 * ============================================================================
 */

let mseTypes = [];
// webOS 6 (Chromium 79): below webOS 25, Dolby Vision MKVs must not direct-play
Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager' },
    configurable: true
});
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080 },
    MediaSource: { isTypeSupported: (type) => mseTypes.some((t) => type.includes(t)) }
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    // The TV itself decodes everything natively
    createElement: () => ({ canPlayType: () => 'probably', addEventListener() {}, style: {} }),
    body: { appendChild() {} }
};

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const { buildJellyfinProfile, clearCapabilitiesCache } = await import('../src/api/profiles/WebOSProfile.js');

PlayerSettings.set('enableEac3', 'enable');
PlayerSettings.set('enableDolbyVision', 'enable');

function profileFor(backend, supportedMseTypes) {
    mseTypes = supportedMseTypes;
    clearCapabilitiesCache();
    const profile = buildJellyfinProfile({ backend });
    const hls = profile.TranscodingProfiles.filter((p) => p.Protocol === 'hls' && p.Type === 'Video');
    const hevcRanges = profile.CodecProfiles.filter((p) => p.Codec === 'hevc')
        .flatMap((p) => p.Conditions)
        .filter((c) => c.Property === 'VideoRangeType')
        .map((c) => c.Value.split('|'));
    return {
        mkvDolbyVisionRemux: profile.CodecProfiles.some(
            // No Codec, or a list that covers HEVC (upstream leaves AV1 out)
            (p) =>
                p.Container === 'mkv' &&
                (!p.Codec || p.Codec.split(',').includes('hevc')) &&
                p.Conditions.some((c) => c.Value === 'DOVIWithHDR10')
        ),
        audio: new Set(hls.flatMap((p) => String(p.AudioCodec).split(','))),
        video: new Set(hls.flatMap((p) => String(p.VideoCodec).split(','))),
        containers: new Set(hls.map((p) => p.Container)),
        allowsDoviProfile5: hevcRanges.length > 0 && hevcRanges.every((values) => values.includes('DOVI'))
    };
}

test('webOS HTML5 profile: no E-AC-3 in MPEG-TS HLS, no AC-3 / HEVC without MSE support, no Dolby Vision', () => {
    const html5 = profileFor('html5', []);
    assert.deepStrictEqual([...html5.containers], ['ts']);
    assert.ok(!html5.audio.has('eac3'), 'eac3 in TS HLS: hls.js fails with "Unsupported EC-3 in M2TS found"');
    assert.ok(!html5.audio.has('ac3'));
    assert.ok(html5.audio.has('aac'));
    assert.deepStrictEqual([...html5.video], ['h264']);
    assert.strictEqual(html5.allowsDoviProfile5, false);
});

test('webOS HTML5 profile: AC-3 and HEVC are kept where MSE supports them', () => {
    const html5 = profileFor('html5', ['ac-3', 'hvc1']);
    assert.ok(html5.audio.has('ac3'));
    assert.ok(!html5.audio.has('eac3'));
    assert.ok(html5.video.has('hevc'));
});

test('webOS native profile is unchanged', () => {
    const native = profileFor('webos', []);
    assert.ok(native.audio.has('eac3'));
    assert.ok(native.audio.has('ac3'));
    assert.ok(native.video.has('hevc'));
    assert.strictEqual(native.allowsDoviProfile5, true);
});

test('webOS HTML5 profile: Dolby Vision MKVs still remux below webOS 25', () => {
    // Removing it would direct-play DV MKVs through the TV pipeline, which stalls on webOS < 25
    assert.strictEqual(profileFor('html5', []).mkvDolbyVisionRemux, true);
    assert.strictEqual(profileFor('webos', []).mkvDolbyVisionRemux, true);
});
