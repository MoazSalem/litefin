import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Device Profile — Codec Probe Test Suite
 * ============================================================================
 * DTS and AV1 support on LG TVs does not follow the webOS version: LG brought
 * DTS back on 2023 sets (webOS 23+) after dropping it for webOS 5–22, webOS
 * Re:New upgrades report a newer version on older hardware, and 2020 α9 Gen 3
 * sets (webOS 5) already decode AV1. Where the TV's media pipeline confirms a
 * codec, the profile advertises it; the version table stays the fallback.
 * The probe results are cached per module instance, so every case imports a
 * fresh copy of WebOSProfile.js.
 * ============================================================================
 */

const CHROME_FOR_WEBOS = { 4: '53.0.2785.34', 5: '68.0.3440.106', 6: '79.0.3945.79', 25: '120.0.6099.270' };

const store = new Map();
globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
        return store.size;
    }
};
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080 },
    MediaSource: { isTypeSupported: () => false }
};

let canPlayType = () => '';
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    createElement: () => ({ canPlayType: (type) => canPlayType(type), addEventListener() {}, style: {} }),
    body: { appendChild() {} }
};

function setWebOSVersion(version) {
    Object.defineProperty(globalThis, 'navigator', {
        value: {
            userAgent: `Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FOR_WEBOS[version]} Safari/537.36 WebAppManager`
        },
        configurable: true
    });
}

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');

let instance = 0;
/** A fresh WebOSProfile module (empty probe cache) on a TV answering canPlayType with `answer(type)`. */
async function loadProfile({ webosVersion, answer, settings = {} }) {
    setWebOSVersion(webosVersion);
    canPlayType = answer;
    store.clear();
    for (const [key, value] of Object.entries(settings)) PlayerSettings.set(key, value);
    return import(`../src/api/profiles/WebOSProfile.js?probe=${++instance}`);
}

const answers =
    (map, fallback = '') =>
    (type) => {
        for (const [needle, answer] of Object.entries(map)) {
            if (type.includes(needle)) return answer;
        }
        return fallback;
    };

function directPlayAudioCodecs(profile) {
    return new Set(profile.DirectPlayProfiles.flatMap((p) => String(p.AudioCodec || '').split(',')).filter(Boolean));
}

test('webOS profile: DTS is advertised on webOS 23+ when the media pipeline confirms it', async () => {
    const { getDeviceCapabilities, buildJellyfinProfile } = await loadProfile({
        webosVersion: 25,
        answer: answers({ dtsc: 'probably', dtsx: 'probably' })
    });
    assert.strictEqual(getDeviceCapabilities().dts, true);
    assert.ok(directPlayAudioCodecs(buildJellyfinProfile()).has('dts'), 'DTS track transcoded on a TV that plays it');
});

test('webOS profile: an empty or "maybe" DTS answer keeps the version table on webOS 5+', async () => {
    for (const answer of [() => '', answers({ dts: 'maybe' })]) {
        const { getDeviceCapabilities } = await loadProfile({ webosVersion: 25, answer });
        assert.strictEqual(getDeviceCapabilities().dts, false);
    }
});

test('webOS profile: the DTS probe never turns DTS off where the version table has it', async () => {
    // webOS 4 decodes DTS but may still answer '' for the MP4 codec strings
    const { getDeviceCapabilities } = await loadProfile({ webosVersion: 4, answer: () => '' });
    assert.strictEqual(getDeviceCapabilities().dts, true);
});

test('webOS profile: the DTS setting overrides the probe', async () => {
    const disabled = await loadProfile({
        webosVersion: 25,
        answer: answers({ dtsc: 'probably' }),
        settings: { enableDts: 'disable' }
    });
    assert.strictEqual(disabled.getDeviceCapabilities().dts, false);

    const enabled = await loadProfile({ webosVersion: 6, answer: () => '', settings: { enableDts: 'enable' } });
    assert.strictEqual(enabled.getDeviceCapabilities().dts, true);
});

function directPlayVideoCodecs(profile) {
    return new Set(profile.DirectPlayProfiles.flatMap((p) => String(p.VideoCodec || '').split(',')).filter(Boolean));
}

test('webOS profile: AV1 is advertised on webOS 5 when the TV reports an AV1 decoder', async () => {
    const { getDeviceCapabilities, buildJellyfinProfile } = await loadProfile({
        webosVersion: 5,
        answer: answers({ av01: 'probably' })
    });
    assert.strictEqual(getDeviceCapabilities().av1, true);
    assert.ok(directPlayVideoCodecs(buildJellyfinProfile()).has('av1'), 'AV1 transcoded on a TV that decodes it');
});

test('webOS profile: AV1 stays off on webOS 5 without a decoder, on webOS 6+ regardless, and follows the setting', async () => {
    const webos5 = await loadProfile({ webosVersion: 5, answer: () => '' });
    assert.strictEqual(webos5.getDeviceCapabilities().av1, false);

    const webos6 = await loadProfile({ webosVersion: 6, answer: () => '' });
    assert.strictEqual(webos6.getDeviceCapabilities().av1, true);

    const disabled = await loadProfile({
        webosVersion: 5,
        answer: answers({ av01: 'probably' }),
        settings: { enableAV1: 'disable' }
    });
    assert.ok(!directPlayVideoCodecs(disabled.buildJellyfinProfile()).has('av1'));
});

function transcodingAudioChannels(profile) {
    return new Set(profile.TranscodingProfiles.filter((p) => p.Type === 'Video' && p.MaxAudioChannels !== undefined).map((p) => Number(p.MaxAudioChannels)));
}

test('webOS profile: DTS passthrough does not raise the channel count of transcoded audio', async () => {
    // LG C4: DTS:X 7.1.4 transcoded to 8-channel E-AC-3 in HLS played as hiss
    const { buildJellyfinProfile } = await loadProfile({ webosVersion: 25, answer: answers({ dtsc: 'probably' }) });
    const profile = buildJellyfinProfile();
    assert.deepStrictEqual([...transcodingAudioChannels(profile)], [6]);
    const sevenOne = profile.CodecProfiles.some((p) => (p.Conditions || []).some((c) => c.Property === 'AudioChannels' && c.Value === '8'));
    assert.ok(sevenOne, 'a DTS 7.1 bitstream should still direct play');
});

test('webOS profile: explicit channel settings still decide the transcoded channel count (guard)', async () => {
    const allowed = await loadProfile({ webosVersion: 25, answer: () => '', settings: { allowedAudioChannels: 8 } });
    assert.deepStrictEqual([...transcodingAudioChannels(allowed.buildJellyfinProfile())], [8]);
    const transcode = await loadProfile({ webosVersion: 25, answer: () => '', settings: { transcodeMaxAudioChannels: 2 } });
    assert.deepStrictEqual([...transcodingAudioChannels(transcode.buildJellyfinProfile())], [2]);
});
