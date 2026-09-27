import assert from 'node:assert/strict';
import test from 'node:test';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
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

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const TizenProfile = await import('../src/api/profiles/TizenProfile.js');

test('TizenProfile: permits AAC 5.1 DirectPlay across progressive containers on Tizen 5.0', () => {
    PlayerSettings.set('allowedAudioChannels', -1); // Auto (default 6)

    const profile = TizenProfile.buildJellyfinProfile({ backend: 'avplay' });

    // 1. Verify generic VideoAudio AAC profile allows 6 channels (5.1 surround)
    const aacVideoAudioProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'VideoAudio' && cp.Codec === 'aac' && !cp.Container
    );
    assert.ok(aacVideoAudioProfile, 'Generic VideoAudio AAC CodecProfile must exist');
    const aacChannelsCondition = aacVideoAudioProfile.Conditions.find((c) => c.Property === 'AudioChannels');
    assert.ok(aacChannelsCondition, 'AudioChannels condition must exist for AAC');
    assert.strictEqual(
        aacChannelsCondition.Value,
        '6',
        'AAC VideoAudio condition on Tizen 5.0 must permit up to 6 channels (5.1) for progressive DirectPlay'
    );

    // 2. Verify generic Audio AAC profile allows 6 channels (5.1 surround)
    const aacAudioProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'Audio' && cp.Codec === 'aac' && !cp.Container
    );
    assert.ok(aacAudioProfile, 'Generic Audio AAC CodecProfile must exist');
    const aacAudioChannelsCondition = aacAudioProfile.Conditions.find((c) => c.Property === 'AudioChannels');
    assert.strictEqual(
        aacAudioChannelsCondition.Value,
        '6',
        'AAC Audio condition on Tizen 5.0 must permit up to 6 channels for music/audiobooks'
    );

    // 3. Verify MPEG-TS container restriction on legacy Tizen AVPlay (< 6.0)
    const aacTsProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'VideoAudio' && cp.Codec === 'aac' && cp.Container === 'ts,mpegts'
    );
    assert.ok(aacTsProfile, 'MPEG-TS specific AAC CodecProfile must exist on Tizen 5.0');
    const aacTsChannelsCondition = aacTsProfile.Conditions.find((c) => c.Property === 'AudioChannels');
    assert.strictEqual(
        aacTsChannelsCondition.Value,
        '2',
        'MPEG-TS AAC condition on Tizen 5.0 AVPlay must restrict to 2 channels to protect TS demuxer'
    );
});

test('TizenProfile: clamps AAC channel cap to 6 even when 7.1 TrueHD/DTS is enabled', () => {
    // When DTS/TrueHD is enabled, defaultMaxChannels becomes 8 for passthrough
    PlayerSettings.set('enableTrueHd', 'enable');
    PlayerSettings.set('allowedAudioChannels', 8);

    const profile = TizenProfile.buildJellyfinProfile({ backend: 'avplay' });

    // AAC hardware decoder on Samsung TVs cannot exceed 5.1 (6 channels)
    const aacVideoAudioProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'VideoAudio' && cp.Codec === 'aac' && !cp.Container
    );
    const aacChannelsCondition = aacVideoAudioProfile.Conditions.find((c) => c.Property === 'AudioChannels');
    assert.strictEqual(
        aacChannelsCondition.Value,
        '6',
        'AAC channel condition must be clamped to 6 even when system max channels is 8'
    );

    // Reset settings
    PlayerSettings.set('enableTrueHd', 'auto');
    PlayerSettings.set('allowedAudioChannels', -1);
});

test('TizenProfile: respects explicit stereo constraint when user sets allowedAudioChannels=2', () => {
    PlayerSettings.set('allowedAudioChannels', 2);

    const profile = TizenProfile.buildJellyfinProfile({ backend: 'avplay' });

    const aacVideoAudioProfile = profile.CodecProfiles.find(
        (cp) => cp.Type === 'VideoAudio' && cp.Codec === 'aac' && !cp.Container
    );
    const aacChannelsCondition = aacVideoAudioProfile.Conditions.find((c) => c.Property === 'AudioChannels');
    assert.strictEqual(
        aacChannelsCondition.Value,
        '2',
        'AAC channel condition must respect user explicit stereo constraint'
    );

    // Reset settings
    PlayerSettings.set('allowedAudioChannels', -1);
});
