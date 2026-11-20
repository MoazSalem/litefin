import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * PCM Audio in Video & Transcoding Fallback Test Suite
 * ============================================================================
 * Verifies that:
 * 1. enablePcmInVideo defaults to false (disabled).
 * 2. TizenProfile conditionally includes/excludes PCM video audio codecs.
 * 3. JellyfinPlayer.isAudioTrackNativelyPlayable respects enablePcmInVideo on Tizen.
 * 4. autoTranscodeOnError defaults to true and is properly toggleable.
 * ============================================================================
 */

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
        value: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/6.0 TV Safari/537.36',
        configurable: true
    });
} catch (e) {
    // Ignore if not configurable
}
globalThis.window = globalThis;

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const TizenProfile = await import('../src/api/profiles/TizenProfile.js');

test('PlayerSettings: enablePcmInVideo defaults to false', () => {
    // Ensure clean state
    storageMap.delete('enablePcmInVideo');
    assert.strictEqual(
        PlayerSettings.get('enablePcmInVideo'),
        false,
        'enablePcmInVideo must be disabled by default'
    );
});

test('PlayerSettings: autoTranscodeOnError defaults to true', () => {
    storageMap.delete('autoTranscodeOnError');
    assert.strictEqual(
        PlayerSettings.get('autoTranscodeOnError'),
        true,
        'autoTranscodeOnError must be enabled by default'
    );
});

test('TizenProfile: excludes PCM codecs from video profiles when enablePcmInVideo is false', () => {
    PlayerSettings.set('enablePcmInVideo', false);

    const profile = TizenProfile.buildJellyfinProfile({ backend: 'avplay' });

    // Video DirectPlay profiles
    const videoProfiles = profile.DirectPlayProfiles.filter((p) => p.Type === 'Video');
    assert.ok(videoProfiles.length > 0, 'Video DirectPlay profiles must be generated');

    for (const p of videoProfiles) {
        const audioCodecs = (p.AudioCodec || '').split(',');
        assert.ok(!audioCodecs.includes('pcm'), 'Video profile must not include pcm when disabled');
        assert.ok(!audioCodecs.includes('wav'), 'Video profile must not include wav when disabled');
        assert.ok(!audioCodecs.includes('pcm_s16le'), 'Video profile must not include pcm_s16le when disabled');
        assert.ok(!audioCodecs.includes('pcm_s24le'), 'Video profile must not include pcm_s24le when disabled');
    }

    // Music profiles should still allow PCM
    const musicProfiles = profile.DirectPlayProfiles.filter((p) => p.Type === 'Audio');
    const musicAudioCodecs = musicProfiles.flatMap((p) => (p.AudioCodec || '').split(','));
    assert.ok(musicAudioCodecs.includes('pcm'), 'Music profiles must always retain pcm');
    assert.ok(musicAudioCodecs.includes('wav'), 'Music profiles must always retain wav');
});

test('TizenProfile: includes PCM codecs in video profiles when enablePcmInVideo is true', () => {
    PlayerSettings.set('enablePcmInVideo', true);

    const profile = TizenProfile.buildJellyfinProfile({ backend: 'avplay' });

    const videoProfiles = profile.DirectPlayProfiles.filter((p) => p.Type === 'Video');
    assert.ok(videoProfiles.length > 0, 'Video DirectPlay profiles must be generated');

    // At least one video DirectPlay profile (e.g. MKV/MP4) must now include pcm and wav
    const allVideoAudioCodecs = videoProfiles.flatMap((p) => (p.AudioCodec || '').split(','));
    assert.ok(allVideoAudioCodecs.includes('pcm'), 'Video profile must include pcm when enabled');
    assert.ok(allVideoAudioCodecs.includes('wav'), 'Video profile must include wav when enabled');
    assert.ok(allVideoAudioCodecs.includes('pcm_s16le'), 'Video profile must include pcm_s16le when enabled');
    assert.ok(allVideoAudioCodecs.includes('pcm_s24le'), 'Video profile must include pcm_s24le when enabled');
});

test('JellyfinPlayer: isAudioTrackNativelyPlayable gates PCM in video by enablePcmInVideo', () => {
    // Load StreamUtils.js in VM context to test isAudioTrackNativelyPlayable
    // (the helper lives there since the DetailsPage decoupling refactor)
    const source = readFileSync('./src/player/core/StreamUtils.js', 'utf8');

    function createSandbox(settings, platform = { isTizen: true, isWebOS: false }) {
        const currentSettings = { ...settings };
        const sandbox = {
            console,
            PlayerSettings: {
                get: (k) => currentSettings[k],
                set: (k, v) => { currentSettings[k] = v; }
            },
            getDeviceCapabilities: () => ({ ac3: true, eac3: true }),
            platformInfo: platform,
            AUDIO_FALLBACK_STORAGE_KEYS: {},
            storage: {
                getItem: () => null,
                setItem: () => {},
                removeItem: () => {}
            },
            log: { info() {}, debug() {}, warn() {}, error() {} },
            MediaHelper: { getTranscodeStatus: () => ({ isVideoDirect: true, isAudioDirect: true }) },
            languageManager: { normalizeLanguage: (lang) => lang }
        };

        const normalizedSource = source.replace(/\r\n/g, '\n');
        const code = `
            ${normalizedSource.slice(
                normalizedSource.indexOf('export const isTrueHdSupported =')
            ).replace(/export /g, '')}
            ({ isAudioTrackNativelyPlayable });
        `;

        const ctx = vm.createContext(sandbox);
        const script = new vm.Script(code);
        return script.runInContext(ctx);
    }

    // 1. Tizen platform with enablePcmInVideo = false
    const { isAudioTrackNativelyPlayable: tizenDisabled } = createSandbox({
        enablePcmInVideo: false
    }, { isTizen: true, isWebOS: false });

    assert.strictEqual(
        tizenDisabled({ Codec: 'pcm_s16le' }, { Container: 'mkv' }, 'tizen'),
        false,
        'PCM track in video must be rejected when enablePcmInVideo is false on Tizen'
    );
    assert.strictEqual(
        tizenDisabled({ Codec: 'wav' }, { Container: 'mkv' }, 'tizen'),
        false,
        'WAV track in video must be rejected when enablePcmInVideo is false on Tizen'
    );

    // 2. Tizen platform with enablePcmInVideo = true
    const { isAudioTrackNativelyPlayable: tizenEnabled } = createSandbox({
        enablePcmInVideo: true
    }, { isTizen: true, isWebOS: false });

    assert.strictEqual(
        tizenEnabled({ Codec: 'pcm_s16le' }, { Container: 'mkv' }, 'tizen'),
        true,
        'PCM track in video must be natively playable when enablePcmInVideo is true on Tizen'
    );
    assert.strictEqual(
        tizenEnabled({ Codec: 'wav' }, { Container: 'mkv' }, 'tizen'),
        true,
        'WAV track in video must be natively playable when enablePcmInVideo is true on Tizen'
    );

    // 3. WebOS platform with enablePcmInVideo = true (must still be false on non-Tizen)
    const { isAudioTrackNativelyPlayable: webosEnabled } = createSandbox({
        enablePcmInVideo: true
    }, { isTizen: false, isWebOS: true });

    assert.strictEqual(
        webosEnabled({ Codec: 'pcm_s16le' }, { Container: 'mkv' }, 'webos'),
        false,
        'PCM track in video must remain false on webOS even if toggle is active'
    );
});
