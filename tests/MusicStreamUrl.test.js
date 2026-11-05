import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHlsAudioUrl, buildStaticAudioUrl } from '../src/music/streamUrl.js';

test('buildStaticAudioUrl jellyfin vs emby key', () => {
    const base = { serverUrl: 'http://s', itemId: 'i', mediaSourceId: 'm', token: 't k', deviceId: 'd' };
    assert.equal(
        buildStaticAudioUrl(base),
        'http://s/Audio/i/stream?static=true&mediaSourceId=m&deviceId=d&ApiKey=t%20k'
    );
    assert.match(buildStaticAudioUrl({ ...base, isEmby: true }), /&api_key=t%20k$/);
});

test('buildHlsAudioUrl', () => {
    const base = {
        serverUrl: 'http://s',
        itemId: 'i',
        mediaSourceId: 'm',
        token: 't k',
        deviceId: 'd',
        playSessionId: 'p1',
        audioCodec: 'copy',
        sampleRate: null
    };
    const url = buildHlsAudioUrl(base);
    assert.ok(url.startsWith('http://s/Audio/i/main.m3u8?'));
    for (const part of [
        'segmentContainer=mp4',
        'audioCodec=copy',
        'segmentLength=4',
        'ApiKey=t%20k',
        'PlaySessionId=p1'
    ]) {
        assert.ok(url.includes(part), part);
    }
    assert.ok(!url.includes('audioSampleRate'));
    assert.ok(buildHlsAudioUrl({ ...base, audioCodec: 'flac', sampleRate: 48000 }).includes('audioSampleRate=48000'));
});
