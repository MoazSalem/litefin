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
        webosSource.includes('if (hasKnownRuntime && isVideoDirect && isHdr'),
        'WebOSPlayer must apply the variant bypass only when runtime, video copy, and HDR are present'
    );
    assert.ok(
        webosSource.includes("rangeType.includes('DOVI')") &&
        webosSource.includes("const isHdr = !isDoVi &&"),
        'WebOSPlayer must exclude Dolby Vision (DOVI) from the master.m3u8 -> main.m3u8 bypass'
    );
    assert.ok(
        webosSource.includes("rangeType.startsWith('HDR') || rangeType.startsWith('HLG')"),
        'WebOSPlayer must detect non-DoVi HDR range types'
    );
});

test('WebOSPlayer: variant bypass rewrites master.m3u8 only for video copy of non-DoVi HDR content', () => {
    // Simulate the URL rewrite logic in WebOSPlayer.play()
    function getAdjustedUrl(options) {
        let streamUrl = options.url;
        const isVideoDirect = options.playMethod === 'DirectStream' ||
                              options.playMethod === 'Remux' ||
                              (options.mediaSource ? options.mediaSource.isVideoDirect : false);
        // Mirror Jellyfin's IsSegmentedLiveStream: no RunTimeTicks means live.m3u8
        const hasKnownRuntime = Boolean(options.mediaSource?.RunTimeTicks);

        const videoStream = (options.mediaSource?.MediaStreams || []).find((s) => s.Type === 'Video');
        const rangeType = (videoStream?.VideoRangeType || videoStream?.VideoRange || '').toUpperCase();
        const extendedRange = (videoStream?.ExtendedVideoRangeType || '').toUpperCase();
        const itemRange = (options.item?.VideoRange || options.item?.VideoRangeType || '').toUpperCase();
        // Dolby Vision requires master.m3u8 for SUPPLEMENTAL-CODECS / CODECS (dvh1)
        const isDoVi = rangeType.includes('DOVI') ||
                       extendedRange.includes('DOVI') ||
                       itemRange.includes('DOVI');
        const isHdr = !isDoVi && (
            rangeType.startsWith('HDR') || rangeType.startsWith('HLG') ||
            extendedRange.startsWith('HDR') || extendedRange.startsWith('HLG') ||
            itemRange.startsWith('HDR') || itemRange.startsWith('HLG')
        );

        if (hasKnownRuntime && isVideoDirect && isHdr && typeof streamUrl === 'string' && streamUrl.includes('/master.m3u8')) {
            streamUrl = streamUrl.replace(/\/master\.m3u8/i, '/main.m3u8');
        }
        return streamUrl;
    }

    const masterUrl = 'http://192.168.1.50:8096/Videos/item123/master.m3u8?DeviceId=dev1&MediaSourceId=src1&VideoCodec=h264,hevc';
    const mainExpected = 'http://192.168.1.50:8096/Videos/item123/main.m3u8?DeviceId=dev1&MediaSourceId=src1&VideoCodec=h264,hevc';
    const runtime = 36000000000; // 1h in ticks, typical VOD source
    const hdrStreams = [{ Type: 'Video', Codec: 'hevc', VideoRangeType: 'HDR10' }];
    const sdrStreams = [{ Type: 'Video', Codec: 'h264', VideoRangeType: 'SDR' }];

    // 1. DirectStream HDR -> rewrites to main.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'DirectStream', mediaSource: { RunTimeTicks: runtime, MediaStreams: hdrStreams } }),
        mainExpected,
        'DirectStream HDR should rewrite master.m3u8 to main.m3u8'
    );

    // 2. Remux HDR -> rewrites to main.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'Remux', mediaSource: { RunTimeTicks: runtime, MediaStreams: hdrStreams } }),
        mainExpected,
        'Remux HDR should rewrite master.m3u8 to main.m3u8'
    );

    // 3. MediaSource with isVideoDirect: true and HDR item -> rewrites to main.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, item: { VideoRange: 'HDR' }, mediaSource: { isVideoDirect: true, RunTimeTicks: runtime } }),
        mainExpected,
        'MediaSource with isVideoDirect and HDR item should rewrite master.m3u8 to main.m3u8'
    );

    // 4. DirectStream SDR -> preserves master.m3u8 (avoids spawning duplicate FFmpeg transcode)
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'DirectStream', mediaSource: { RunTimeTicks: runtime, MediaStreams: sdrStreams } }),
        masterUrl,
        'DirectStream SDR must preserve master.m3u8'
    );

    // 5. Remux SDR -> preserves master.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'Remux', mediaSource: { RunTimeTicks: runtime, MediaStreams: sdrStreams } }),
        masterUrl,
        'Remux SDR must preserve master.m3u8'
    );

    // 6. Full Transcode (video transcode) -> preserves master.m3u8
    assert.equal(
        getAdjustedUrl({ url: masterUrl, playMethod: 'Transcode', mediaSource: { RunTimeTicks: runtime, MediaStreams: hdrStreams } }),
        masterUrl,
        'Full transcode must preserve master.m3u8'
    );

    // 7. Non-master HLS URL (e.g. already main.m3u8 or live.m3u8) -> preserved untouched
    const liveUrl = 'http://192.168.1.50:8096/Videos/item123/live.m3u8?DeviceId=dev1';
    assert.equal(
        getAdjustedUrl({ url: liveUrl, playMethod: 'DirectStream', mediaSource: { RunTimeTicks: runtime, MediaStreams: hdrStreams } }),
        liveUrl,
        'Non-master URLs must remain untouched'
    );

    // 8. Live TV channel (TvChannel, no runtime) with video copy -> keeps master.m3u8,
    //    because main.m3u8 is generated only for sources with RunTimeTicks.
    const liveMasterUrl = 'http://192.168.1.50:8096/videos/item-live/master.m3u8?DeviceId=dev1&LiveStreamId=ls1';
    assert.equal(
        getAdjustedUrl({
            url: liveMasterUrl,
            playMethod: 'DirectStream',
            item: { Type: 'TvChannel' },
            mediaSource: { LiveStreamId: 'ls1', isVideoDirect: true, MediaStreams: hdrStreams }
        }),
        liveMasterUrl,
        'Live TV (TvChannel) must keep master.m3u8'
    );

    // 9. In-progress recording: infinite stream, no LiveStreamId, no runtime -> keeps master
    assert.equal(
        getAdjustedUrl({
            url: masterUrl,
            playMethod: 'DirectStream',
            item: { Type: 'Recording' },
            mediaSource: { IsInfiniteStream: true, isVideoDirect: true, MediaStreams: hdrStreams }
        }),
        masterUrl,
        'Infinite/runtime-less sources must keep master.m3u8'
    );

    // 10. Channel-plugin VOD that requires opening (LiveStreamId) but has a runtime and HDR
    //    still gets the bypass, matching Jellyfin's main.m3u8 generation.
    assert.equal(
        getAdjustedUrl({
            url: masterUrl,
            playMethod: 'DirectStream',
            item: { Type: 'Movie' },
            mediaSource: { LiveStreamId: 'ls1', isVideoDirect: true, RunTimeTicks: runtime, MediaStreams: hdrStreams }
        }),
        mainExpected,
        'A source with a known runtime and HDR must still rewrite to main.m3u8'
    );

    // 11. VOD item with no LiveStreamId and HDR still gets the bypass
    assert.equal(
        getAdjustedUrl({
            url: masterUrl,
            playMethod: 'DirectStream',
            item: { Type: 'Movie', VideoRange: 'HDR' },
            mediaSource: { isVideoDirect: true, RunTimeTicks: runtime }
        }),
        mainExpected,
        'VOD HDR items must still rewrite to main.m3u8'
    );

    // 12. Dolby Vision Profile 8 (DOVIWithHDR10) with audio transcode -> preserves master.m3u8
    //     so webOS receives SUPPLEMENTAL-CODECS="dvh1..." and triggers Dolby Vision instead of HDR10
    const dvP8Streams = [{ Type: 'Video', Codec: 'hevc', VideoRangeType: 'DOVIWithHDR10' }];
    assert.equal(
        getAdjustedUrl({
            url: masterUrl,
            playMethod: 'DirectStream',
            mediaSource: { RunTimeTicks: runtime, MediaStreams: dvP8Streams }
        }),
        masterUrl,
        'DirectStream Dolby Vision Profile 8 (DOVIWithHDR10) must preserve master.m3u8'
    );

    // 13. Dolby Vision Profile 5 (DOVI) -> preserves master.m3u8 for dvh1 variant selection
    const dvP5Streams = [{ Type: 'Video', Codec: 'hevc', VideoRangeType: 'DOVI' }];
    assert.equal(
        getAdjustedUrl({
            url: masterUrl,
            playMethod: 'Remux',
            mediaSource: { RunTimeTicks: runtime, MediaStreams: dvP5Streams }
        }),
        masterUrl,
        'Remux Dolby Vision Profile 5 (DOVI) must preserve master.m3u8'
    );

    // 14. Dolby Vision via ExtendedVideoRangeType -> preserves master.m3u8
    const dvExtendedStreams = [{ Type: 'Video', Codec: 'hevc', VideoRangeType: 'HDR10', ExtendedVideoRangeType: 'DOVIWithHDR10' }];
    assert.equal(
        getAdjustedUrl({
            url: masterUrl,
            playMethod: 'DirectStream',
            mediaSource: { RunTimeTicks: runtime, MediaStreams: dvExtendedStreams }
        }),
        masterUrl,
        'Dolby Vision detected via ExtendedVideoRangeType must preserve master.m3u8'
    );
});
