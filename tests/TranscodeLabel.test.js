import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Transcode Label Test Suite
 * ============================================================================
 * A quality limit below the source bitrate makes the server re-encode the
 * video, but the TranscodingUrl only names ContainerBitrateExceedsLimit and
 * keeps the source codec in VideoCodec. The play method must still be
 * Transcode (it was labelled Remux). Every transcoding URL carries a
 * VideoBitrate, remuxes included, so only a source above it is re-encoded;
 * the server applies the same rule (EncodingHelper.CanStreamCopyVideo).
 * ============================================================================
 */

globalThis.window = globalThis.window || { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    key: () => null,
    length: 0
};

const { MediaHelper } = await import('../src/player/core/MediaHelper.js');

/** 4K HEVC source at 45 Mbps with E-AC-3 audio. */
function source(query, video = {}) {
    return {
        Id: 'ms',
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'hevc', BitRate: 45000000, Width: 3840, Height: 2160, ...video },
            { Index: 1, Type: 'Audio', Codec: 'eac3', BitRate: 640000, IsDefault: true }
        ],
        TranscodingSubProtocol: 'hls',
        TranscodingUrl:
            '/videos/item/master.m3u8?MediaSourceId=ms&VideoCodec=hevc,h264&AudioCodec=eac3,ac3,aac' +
            `&AudioStreamIndex=1&${query}&SegmentContainer=mp4&PlaySessionId=p`
    };
}

test('MediaHelper: a quality limit below the source bitrate is a transcode, not a remux', () => {
    // 8 Mbps picked in the OSD
    const limited = source('VideoBitrate=7616000&AudioBitrate=384000&TranscodeReasons=ContainerBitrateExceedsLimit');
    assert.strictEqual(MediaHelper.getTranscodeStatus(limited).isVideoDirect, false);
    assert.strictEqual(MediaHelper.getPlayMethod(limited), 'Transcode');
});

test('MediaHelper: a size limit below the source resolution is a transcode', () => {
    const scaled = source('VideoBitrate=119000000&MaxWidth=1920&MaxHeight=1080&TranscodeReasons=ContainerNotSupported');
    assert.strictEqual(MediaHelper.getPlayMethod(scaled), 'Transcode');
});

test('MediaHelper: a remux within the limits stays a remux (guard)', () => {
    // Every transcoding URL has a VideoBitrate; the source fits under it
    const remux = source('VideoBitrate=119360000&AudioBitrate=640000&TranscodeReasons=ContainerNotSupported');
    assert.strictEqual(MediaHelper.getPlayMethod(remux), 'Remux');

    // Over the container limit only because of the audio: the video is still copied
    const audioHeavy = source('VideoBitrate=39616000&AudioBitrate=384000&TranscodeReasons=ContainerBitrateExceedsLimit', {
        BitRate: 30000000
    });
    assert.strictEqual(MediaHelper.getTranscodeStatus(audioHeavy).isVideoDirect, true);
});

test('MediaHelper: a source with unknown bitrate is not labelled a transcode on a guess (guard)', () => {
    const unknown = source('VideoBitrate=7616000&TranscodeReasons=ContainerNotSupported', { BitRate: undefined });
    assert.strictEqual(MediaHelper.getPlayMethod(unknown), 'Remux');
});

test('JellyfinPlayer: a forced remux above the bitrate limit is reported as a transcode', () => {
    const jellyfinSource = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
        /\r\n/g,
        '\n'
    );
    const signature = '_resolveForcedRemuxPlayMethod(mediaSource, playMethod) {';
    const start = jellyfinSource.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1);
    const method = jellyfinSource.slice(start + 1, jellyfinSource.indexOf('\n    }\n', start) + 6);
    const player = vm.runInNewContext(`({\n${method}\n})`, {
        MediaHelper,
        log: { info() {}, debug() {}, warn() {}, error() {} }
    });

    // Change Container with no target video codec, but an 8 Mbps limit on a 45 Mbps source
    const limited = source('VideoBitrate=7616000&TranscodeReasons=ContainerNotSupported,VideoCodecNotSupported');
    limited.TranscodingUrl = limited.TranscodingUrl.replace('VideoCodec=hevc,h264&', '');
    assert.strictEqual(player._resolveForcedRemuxPlayMethod(limited, 'Transcode'), 'Transcode');

    // Within the limit it is still the remux it was asked for
    const remux = source('VideoBitrate=119360000&TranscodeReasons=ContainerNotSupported,VideoCodecNotSupported');
    remux.TranscodingUrl = remux.TranscodingUrl.replace('VideoCodec=hevc,h264&', '');
    assert.strictEqual(player._resolveForcedRemuxPlayMethod(remux, 'Transcode'), 'Remux');
});
