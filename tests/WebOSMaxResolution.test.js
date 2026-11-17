import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Max Resolution Test Suite
 * ============================================================================
 * The server only scales a transcode down when it has to cut the bitrate, so
 * a 4K file under the max bitrate reaches a 1080p panel at full size and
 * fails to play. The webOS profile must send a Width / Height limit:
 *   - from the "Max resolution" setting, which the settings menu stores as
 *     'WIDTHxHEIGHT' (e.g. '1920x1080');
 *   - in auto mode, from the uhd / uhd8K flags once webOS has reported them,
 *     and not before (until then a 4K panel looks like 1080p).
 * ============================================================================
 */

// A webOS TV whose web app reports a 1080p viewport (the usual case, 4K or not)
Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.270 Safari/537.36 WebAppManager' },
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

const { webosAdapter } = await import('../src/webos/WebOSAdapter.js');
const { storage } = await import('../src/utils/StorageService.js');
const { BaseProfile } = await import('../src/api/profiles/BaseProfile.js');
const WebOSProfile = await import('../src/api/profiles/WebOSProfile.js');

/** Build a fresh webOS profile for the given device info and Max resolution setting. */
function buildProfile({ deviceInfo = null, maxResolution = 'auto', forceTranscode = false, playbackMode } = {}) {
    webosAdapter._deviceInfo = deviceInfo;
    storage.setItem('player:maxResolution', maxResolution);
    storage.setItem('player:forceTranscode', String(forceTranscode));
    WebOSProfile.clearCapabilitiesCache();
    return WebOSProfile.buildJellyfinProfile(playbackMode ? { playbackMode } : {});
}

/** The codec-independent Video size limit, as { width, height }, or null when absent. */
function getSizeLimit(profile) {
    const sizeProfile = profile.CodecProfiles.find(
        (p) => p.Type === 'Video' && !p.Codec && p.Conditions.some((c) => c.Property === 'Width')
    );
    if (!sizeProfile) return null;
    const value = (property) => {
        const condition = sizeProfile.Conditions.find((c) => c.Property === property);
        assert.strictEqual(condition.Condition, 'LessThanEqual');
        return Number(condition.Value);
    };
    return { width: value('Width'), height: value('Height') };
}

test('BaseProfile.getMaxResolution: parses the values the settings menu stores', () => {
    assert.deepStrictEqual(BaseProfile.getMaxResolution('1920x1080'), { width: 1920, height: 1080 });
    assert.deepStrictEqual(BaseProfile.getMaxResolution('3840x2160'), { width: 3840, height: 2160 });
    assert.deepStrictEqual(BaseProfile.getMaxResolution('1280x720'), { width: 1280, height: 720 });
    assert.deepStrictEqual(BaseProfile.getMaxResolution('7680x4320'), { width: 7680, height: 4320 });
});

test('BaseProfile.getMaxResolution: accepts the legacy NNNNp values', () => {
    assert.deepStrictEqual(BaseProfile.getMaxResolution('1080p'), { width: 1920, height: 1080 });
    assert.deepStrictEqual(BaseProfile.getMaxResolution('2160p'), { width: 3840, height: 2160 });
});

test('BaseProfile.getMaxResolution: auto, empty and unknown values mean no limit', () => {
    assert.strictEqual(BaseProfile.getMaxResolution('auto'), null);
    assert.strictEqual(BaseProfile.getMaxResolution(''), null);
    assert.strictEqual(BaseProfile.getMaxResolution(null), null);
    assert.strictEqual(BaseProfile.getMaxResolution('huge'), null);
    assert.strictEqual(BaseProfile.getMaxResolution('0x1080'), null);
});

test('webOS: Max resolution 1920x1080 limits the video size, even on a 4K panel', () => {
    const profile = buildProfile({ deviceInfo: { uhd: true }, maxResolution: '1920x1080' });
    assert.deepStrictEqual(getSizeLimit(profile), { width: 1920, height: 1080 });
    // The setting also drops the UHD bitrate default (40 Mbps instead of 120)
    assert.strictEqual(profile.MaxStreamingBitrate, 40000000);
});

test('webOS: Max resolution 1280x720 limits the video size to 720p', () => {
    const profile = buildProfile({ deviceInfo: { uhd: false }, maxResolution: '1280x720' });
    assert.deepStrictEqual(getSizeLimit(profile), { width: 1280, height: 720 });
});

test('webOS auto: a reported 1080p panel limits the video size to 1920x1080', () => {
    const profile = buildProfile({ deviceInfo: { modelName: '27SR50F-WA', uhd: false } });
    assert.deepStrictEqual(getSizeLimit(profile), { width: 1920, height: 1080 });
});

test('webOS auto: a reported 4K panel is limited to 3840x2160', () => {
    const profile = buildProfile({ deviceInfo: { modelName: 'OLED42C41LA', uhd: true } });
    assert.deepStrictEqual(getSizeLimit(profile), { width: 3840, height: 2160 });
});

test('webOS auto: no size limit before webOS reports the panel', () => {
    // A 4K panel looks like 1080p until deviceInfo arrives; a limit then would block 4K
    const profile = buildProfile({ deviceInfo: null });
    assert.strictEqual(getSizeLimit(profile), null);
});

test('webOS: the Force Transcode playback mode keeps the size limit', () => {
    // Force Transcode is what users pick from the playback error dialog
    const profile = buildProfile({ deviceInfo: { uhd: false }, maxResolution: '1920x1080', playbackMode: 'transcode' });
    assert.deepStrictEqual(getSizeLimit(profile), { width: 1920, height: 1080 });
});

test('webOS: the Force Transcode setting keeps the size limit', () => {
    const profile = buildProfile({ deviceInfo: { uhd: false }, maxResolution: '1920x1080', forceTranscode: true });
    assert.deepStrictEqual(getSizeLimit(profile), { width: 1920, height: 1080 });
});

test('webOS: Force Transcode without a known limit sends no size condition', () => {
    const profile = buildProfile({ deviceInfo: null, playbackMode: 'transcode' });
    assert.deepStrictEqual(profile.CodecProfiles, []);
});

test('webOS auto: no size limit when deviceInfo does not say whether the panel is UHD', () => {
    const profile = buildProfile({ deviceInfo: { modelName: 'LG TV' } });
    assert.strictEqual(getSizeLimit(profile), null);
});
