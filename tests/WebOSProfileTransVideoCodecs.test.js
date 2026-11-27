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
    addEventListener() {},
    removeEventListener() {},
    body: { appendChild() {} }
};

const { buildJellyfinProfile, clearCapabilitiesCache } = await import('../src/api/profiles/WebOSProfile.js');
const { isAudioTrackNativelyPlayable, doesAudioTrackRequireDirectStream } = await import('../src/player/core/StreamUtils.js');

test('WebOSProfile: remux and transcodeAudio use valid video codecs, never "copy"', () => {
    clearCapabilitiesCache();

    // 1. Remux mode
    const remuxProfile = buildJellyfinProfile({ playbackMode: 'remux' });
    const remuxHlsProfiles = remuxProfile.TranscodingProfiles.filter((p) => p.Protocol === 'hls' && p.Type === 'Video');
    assert.ok(remuxHlsProfiles.length > 0, 'Must have HLS video transcoding profiles in remux mode');
    for (const p of remuxHlsProfiles) {
        assert.notEqual(p.VideoCodec, 'copy', 'VideoCodec must never be literal "copy" (causes VideoCodecNotSupported on Jellyfin server)');
        assert.ok(p.VideoCodec.includes('h264'), 'VideoCodec must include h264');
        // MPEG-TS cannot carry AV1 or VP9 on webOS; only fMP4 ('mp4') may advertise them.
        if (p.Container === 'ts') {
            assert.ok(!p.VideoCodec.split(',').includes('av1'), 'MPEG-TS HLS profile must never advertise av1');
            assert.ok(!p.VideoCodec.split(',').includes('vp9'), 'MPEG-TS HLS profile must never advertise vp9');
        }
        if (p.Container === 'mp4') {
            assert.ok(p.VideoCodec.split(',').includes('av1'), 'fMP4 HLS profile must advertise av1 when supported');
        }
    }

    // 2. TranscodeAudio mode
    clearCapabilitiesCache();
    const transAudioProfile = buildJellyfinProfile({ playbackMode: 'transcodeAudio' });
    const transAudioHlsProfiles = transAudioProfile.TranscodingProfiles.filter((p) => p.Protocol === 'hls' && p.Type === 'Video');
    assert.ok(transAudioHlsProfiles.length > 0, 'Must have HLS video transcoding profiles in transcodeAudio mode');
    for (const p of transAudioHlsProfiles) {
        assert.notEqual(p.VideoCodec, 'copy', 'VideoCodec must never be literal "copy"');
        assert.ok(p.VideoCodec.includes('h264'), 'VideoCodec must include h264');
        if (p.Container === 'ts') {
            assert.ok(!p.VideoCodec.split(',').includes('av1'), 'MPEG-TS HLS profile must never advertise av1');
            assert.ok(!p.VideoCodec.split(',').includes('vp9'), 'MPEG-TS HLS profile must never advertise vp9');
        }
        if (p.Container === 'mp4') {
            assert.ok(p.VideoCodec.split(',').includes('av1'), 'fMP4 HLS profile must advertise av1 when supported');
        }
    }
});

test('StreamUtils: Opus audio in MKV/MP4 is natively playable on webOS 4+ without forcing remux', () => {
    const mkvOpusSource = {
        Container: 'mkv',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'av1' },
            { Index: 1, Type: 'Audio', Codec: 'opus', Channels: 2, IsDefault: true },
            { Index: 2, Type: 'Audio', Codec: 'opus', Channels: 2, IsDefault: false }
        ]
    };

    assert.equal(
        isAudioTrackNativelyPlayable(mkvOpusSource.MediaStreams[1], mkvOpusSource, 'webos'),
        true,
        'Opus in MKV must be natively playable on webOS 4+'
    );
    assert.equal(
        doesAudioTrackRequireDirectStream(mkvOpusSource, 1, 'webos'),
        false,
        'Default Opus track in AV1 MKV must DirectPlay on webOS without forcing remux'
    );
});
