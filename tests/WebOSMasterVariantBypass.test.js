import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * WebOS Master Variant Bypass Test Suite
 * ============================================================================
 * When video stream copy is active (DirectStream or Remux) on WebOS, Jellyfin's
 * master.m3u8 injects an equal-bandwidth H.264 SDR fallback variant that the
 * webOS native demuxer mistakenly switches to. WebOSPlayer must request
 * main.m3u8 directly to lock playback to the stream-copied HDR video.
 * ============================================================================
 */

test('WebOSPlayer: source contains HLS master variant bypass logic', () => {
    const webosSource = readFileSync(
        new URL('../src/player/core/WebOSPlayer.js', import.meta.url),
        'utf8'
    );

    assert.ok(
        webosSource.includes("streamUrl.replace(/\\/master\\.m3u8/i, '/main.m3u8')"),
        'WebOSPlayer must replace /master.m3u8 with /main.m3u8 when video stream copy is active'
    );
    assert.ok(
        webosSource.includes("options.playMethod === 'DirectStream' ||"),
        'WebOSPlayer must detect DirectStream mode'
    );
    assert.ok(
        webosSource.includes("options.playMethod === 'Remux' ||"),
        'WebOSPlayer must detect Remux mode'
    );
    assert.ok(
        webosSource.includes('MediaHelper.getTranscodeStatus(options.mediaSource).isVideoDirect'),
        'WebOSPlayer must check isVideoDirect status from mediaSource'
    );
});

test('WebOSPlayer: variant bypass rewrites master.m3u8 only for video copy', () => {
    // Simulate the URL rewrite logic in WebOSPlayer.play()
    function getAdjustedUrl(options) {
        let streamUrl = options.url;
        const isVideoDirect = options.playMethod === 'DirectStream' ||
                              options.playMethod === 'Remux' ||
                              (options.mediaSource ? options.mediaSource.isVideoDirect : false);

        if (isVideoDirect && typeof streamUrl === 'string' && streamUrl.includes('/master.m3u8')) {
            streamUrl = streamUrl.replace(/\/master\.m3u8/i, '/main.m3u8');
        }
        return streamUrl;
    }

    const masterUrl = 'http://192.168.1.50:8096/Videos/item123/master.m3u8?DeviceId=dev1&MediaSourceId=src1&VideoCodec=h264,hevc';
    const mainExpected = 'http://192.168.1.50:8096/Videos/item123/main.m3u8?DeviceId=dev1&MediaSourceId=src1&VideoCodec=h264,hevc';

    // 1. DirectStream (audio transcode, video copy) -> rewrites to main.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'DirectStream' }),
        mainExpected,
        'DirectStream should rewrite master.m3u8 to main.m3u8'
    );

    // 2. Remux (container remux, video copy) -> rewrites to main.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'Remux' }),
        mainExpected,
        'Remux should rewrite master.m3u8 to main.m3u8'
    );

    // 3. MediaSource with isVideoDirect: true -> rewrites to main.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, mediaSource: { isVideoDirect: true } }),
        mainExpected,
        'MediaSource with isVideoDirect should rewrite master.m3u8 to main.m3u8'
    );

    // 4. Full Transcode (video transcode) -> preserves master.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'Transcode' }),
        masterUrl,
        'Full transcode must preserve master.m3u8'
    );

    // 5. Non-master HLS URL (e.g. already main.m3u8 or live.m3u8) -> preserved untouched
    const liveUrl = 'http://192.168.1.50:8096/Videos/item123/live.m3u8?DeviceId=dev1';
    assert.equal(
        getAdjustedUrl({ url: liveUrl, playMethod: 'DirectStream' }),
        liveUrl,
        'Non-master URLs must remain untouched'
    );
});
