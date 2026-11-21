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
 *
 * Sources without RunTimeTicks are exempt: Jellyfin treats them as segmented
 * live streams (master.m3u8 points at live.m3u8) and main.m3u8 answers 500
 * ("Invalid segment length or runtime ticks (0)"), so they keep master.m3u8.
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
    assert.ok(
        webosSource.includes('Boolean(options.mediaSource?.RunTimeTicks)'),
        'WebOSPlayer must detect whether the source has a known runtime'
    );
    assert.ok(
        webosSource.includes('if (hasKnownRuntime && isVideoDirect'),
        'WebOSPlayer must skip the variant bypass for runtime-less (live) sources'
    );
});

test('WebOSPlayer: variant bypass rewrites master.m3u8 only for video copy', () => {
    // Simulate the URL rewrite logic in WebOSPlayer.play()
    function getAdjustedUrl(options) {
        let streamUrl = options.url;
        const isVideoDirect = options.playMethod === 'DirectStream' ||
                              options.playMethod === 'Remux' ||
                              (options.mediaSource ? options.mediaSource.isVideoDirect : false);
        // Mirror Jellyfin's IsSegmentedLiveStream: no RunTimeTicks means live.m3u8
        const hasKnownRuntime = Boolean(options.mediaSource?.RunTimeTicks);

        if (hasKnownRuntime && isVideoDirect && typeof streamUrl === 'string' && streamUrl.includes('/master.m3u8')) {
            streamUrl = streamUrl.replace(/\/master\.m3u8/i, '/main.m3u8');
        }
        return streamUrl;
    }

    const masterUrl = 'http://192.168.1.50:8096/Videos/item123/master.m3u8?DeviceId=dev1&MediaSourceId=src1&VideoCodec=h264,hevc';
    const mainExpected = 'http://192.168.1.50:8096/Videos/item123/main.m3u8?DeviceId=dev1&MediaSourceId=src1&VideoCodec=h264,hevc';
    const runtime = 36000000000; // 1h in ticks, typical VOD source

    // 1. DirectStream (audio transcode, video copy) -> rewrites to main.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'DirectStream', mediaSource: { RunTimeTicks: runtime } }),
        mainExpected,
        'DirectStream should rewrite master.m3u8 to main.m3u8'
    );

    // 2. Remux (container remux, video copy) -> rewrites to main.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'Remux', mediaSource: { RunTimeTicks: runtime } }),
        mainExpected,
        'Remux should rewrite master.m3u8 to main.m3u8'
    );

    // 3. MediaSource with isVideoDirect: true -> rewrites to main.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, mediaSource: { isVideoDirect: true, RunTimeTicks: runtime } }),
        mainExpected,
        'MediaSource with isVideoDirect should rewrite master.m3u8 to main.m3u8'
    );

    // 4. Full Transcode (video transcode) -> preserves master.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'Transcode', mediaSource: { RunTimeTicks: runtime } }),
        masterUrl,
        'Full transcode must preserve master.m3u8'
    );

    // 5. Non-master HLS URL (e.g. already main.m3u8 or live.m3u8) -> preserved untouched
    const liveUrl = 'http://192.168.1.50:8096/Videos/item123/live.m3u8?DeviceId=dev1';
    assert.equal(
        getAdjustedUrl({ url: liveUrl, playMethod: 'DirectStream', mediaSource: { RunTimeTicks: runtime } }),
        liveUrl,
        'Non-master URLs must remain untouched'
    );

    // 6. Live TV channel (TvChannel, no runtime) with video copy -> keeps master.m3u8,
    //    because main.m3u8 is generated only for sources with RunTimeTicks.
    const liveMasterUrl = 'http://192.168.1.50:8096/videos/item-live/master.m3u8?DeviceId=dev1&LiveStreamId=ls1';
    assert.equal(
        getAdjustedUrl({
            url: liveMasterUrl,
            playMethod: 'DirectStream',
            item: { Type: 'TvChannel' },
            mediaSource: { LiveStreamId: 'ls1', isVideoDirect: true }
        }),
        liveMasterUrl,
        'Live TV (TvChannel) must keep master.m3u8'
    );

    // 7. In-progress recording: infinite stream, no LiveStreamId, no runtime -> keeps master
    assert.equal(
        getAdjustedUrl({
            url: masterUrl,
            playMethod: 'DirectStream',
            item: { Type: 'Recording' },
            mediaSource: { IsInfiniteStream: true, isVideoDirect: true }
        }),
        masterUrl,
        'Infinite/runtime-less sources must keep master.m3u8'
    );

    // 8. Channel-plugin VOD that requires opening (LiveStreamId) but has a runtime
    //    still gets the bypass, matching Jellyfin's main.m3u8 generation.
    assert.equal(
        getAdjustedUrl({
            url: masterUrl,
            playMethod: 'DirectStream',
            item: { Type: 'Movie' },
            mediaSource: { LiveStreamId: 'ls1', isVideoDirect: true, RunTimeTicks: runtime }
        }),
        mainExpected,
        'A source with a known runtime must still rewrite to main.m3u8'
    );

    // 9. VOD item with no LiveStreamId still gets the bypass
    assert.equal(
        getAdjustedUrl({
            url: masterUrl,
            playMethod: 'DirectStream',
            item: { Type: 'Movie' },
            mediaSource: { isVideoDirect: true, RunTimeTicks: runtime }
        }),
        mainExpected,
        'VOD items must still rewrite to main.m3u8'
    );
});
