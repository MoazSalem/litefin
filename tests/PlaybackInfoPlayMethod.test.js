import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Playback Info Play Method Test Suite
 * ============================================================================
 * A forced remux's TranscodingUrl names no target video codec and lists
 * VideoCodecNotSupported (current Jellyfin drops the requested 'copy'), yet
 * the server copies the video. JellyfinPlayer resolves it as Remux or
 * DirectStream, but Playback Info derived its own method from the URL and
 * showed "Transcoding" and "H264 → ?" (on an LG C4, for a file the server
 * log shows as a remux with video and audio copied). The panel must show
 * the player's resolved method and stream copies.
 * update() is taken from the source and run on a stub panel (the module
 * itself needs a full DOM).
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

const source = readFileSync(new URL('../src/player/osd/PlaybackInfo.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function extractMethod(signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

const methods = vm.runInContext(
    `({\n${extractMethod('update() {')}\n})`,
    vm.createContext({
        MediaHelper,
        PlayerSettings: { get: () => null },
        i18n: { t: (key) => key },
        platformInfo: { isWebOS: true }
    })
);

/** 1080p H.264 file with one audio track, played through a TranscodingUrl. */
function mediaSource(audioCodec, query) {
    return {
        Id: 'ms',
        Container: 'mp4',
        SupportsDirectPlay: false,
        SupportsDirectStream: true,
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'h264', BitRate: 1707701, Width: 1920, Height: 1080 },
            { Index: 1, Type: 'Audio', Codec: audioCodec, BitRate: 448000, Channels: 6, IsDefault: true }
        ],
        TranscodingSubProtocol: 'hls',
        TranscodingUrl: `/videos/item/master.m3u8?MediaSourceId=ms&AudioStreamIndex=1&${query}&SegmentContainer=ts&PlaySessionId=p`
    };
}

/** Panel rows in order, as [label, value] pairs. */
function render(source, playMethod) {
    const content = { innerHTML: '' };
    const panel = Object.assign(Object.create(methods), {
        isVisible: true,
        $el: { querySelector: () => content },
        osd: { api: { serverUrl: 'http://srv' } },
        player: {
            backendType: 'webos',
            useTizenPlayer: false,
            getCurrentMediaSource: () => source,
            getCurrentAudioStreamIndex: () => 1,
            getMaxBitrate: () => 0,
            ...(playMethod === undefined ? {} : { getCurrentPlayMethod: () => playMethod })
        }
    });
    panel.update();
    return [...content.innerHTML.matchAll(/<span class="pi-label">([^<]*)<\/span>\s*<span class="pi-value">([^<]*)<\/span>/g)].map(
        (m) => [m[1], m[2]]
    );
}

/** First value of a label: the Transcoding Info section comes before the original media info. */
const value = (rows, label) => (rows.find(([l]) => l === label) || [])[1];

// Forced remux of an MP4 (H.264 + E-AC-3), as on the C4
const REMUX = mediaSource(
    'eac3',
    'AudioCodec=eac3&VideoBitrate=119552000&AudioBitrate=448000&TranscodingMaxAudioChannels=6&TranscodeReasons=VideoCodecNotSupported,DirectPlayError'
);

test('PlaybackInfo: a forced remux the player resolved shows as Remuxing with both streams copied', () => {
    const rows = render(REMUX, 'Remux');
    assert.strictEqual(value(rows, 'LabelPlayMethod'), 'Remuxing');
    assert.strictEqual(value(rows, 'LabelVideoCodec'), 'H264 (copy)');
    assert.strictEqual(value(rows, 'LabelAudioCodec'), 'EAC3 (copy)');
    // VideoCodecNotSupported only reflects the dropped 'copy' request
    assert.strictEqual(value(rows, 'LabelTranscodeReasons'), 'DirectPlayError');
});

test('PlaybackInfo: a forced direct stream shows the video copied and the audio converted', () => {
    const dts = mediaSource(
        'dts',
        'AudioCodec=eac3,ac3&VideoBitrate=119360000&AudioBitrate=640000&TranscodingMaxAudioChannels=6&TranscodeReasons=VideoCodecNotSupported,AudioCodecNotSupported,DirectPlayError'
    );
    const rows = render(dts, 'DirectStream');
    assert.strictEqual(value(rows, 'LabelPlayMethod'), 'DirectStreaming');
    assert.strictEqual(value(rows, 'LabelVideoCodec'), 'H264 (copy)');
    // The server picks one of the listed codecs (AC-3 for this DTS:X file on the C4)
    assert.strictEqual(value(rows, 'LabelAudioCodec'), 'DTS → EAC3/AC3 @ 640 kbps');
    assert.strictEqual(value(rows, 'LabelTranscodeReasons'), 'AudioCodecNotSupported, DirectPlayError');
});

test('PlaybackInfo: a real transcode still shows Transcoding (guard)', () => {
    const hevc = mediaSource(
        'eac3',
        'VideoCodec=h264&AudioCodec=aac&VideoBitrate=7616000&AudioBitrate=384000&TranscodeReasons=VideoCodecNotSupported,AudioCodecNotSupported'
    );
    hevc.MediaStreams[0].Codec = 'hevc';
    const rows = render(hevc, 'Transcode');
    assert.strictEqual(value(rows, 'LabelPlayMethod'), 'Transcoding');
    assert.strictEqual(value(rows, 'LabelVideoCodec'), 'HEVC → H264');
    assert.strictEqual(value(rows, 'LabelAudioCodec'), 'EAC3 → AAC @ 384 kbps');
    assert.strictEqual(value(rows, 'LabelTranscodeReasons'), 'VideoCodecNotSupported, AudioCodecNotSupported');
});

test('PlaybackInfo: without a resolved method the panel derives it from the media source (guard)', () => {
    assert.strictEqual(value(render(REMUX, undefined), 'LabelPlayMethod'), 'Transcoding');
    assert.strictEqual(value(render(REMUX, null), 'LabelPlayMethod'), 'Transcoding');
});

test('PlaybackInfo: the transcode reasons label has an English text', () => {
    const english = JSON.parse(readFileSync(new URL('../src/locales/en-us.json', import.meta.url), 'utf8'));
    assert.strictEqual(typeof english.LabelTranscodeReasons, 'string');
});
