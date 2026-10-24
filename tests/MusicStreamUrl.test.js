import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStaticAudioUrl } from '../src/music/streamUrl.js';

test('buildStaticAudioUrl jellyfin vs emby key', () => {
    const base = { serverUrl: 'http://s', itemId: 'i', mediaSourceId: 'm', token: 't k', deviceId: 'd' };
    assert.equal(
        buildStaticAudioUrl(base),
        'http://s/Audio/i/stream?static=true&mediaSourceId=m&deviceId=d&ApiKey=t%20k'
    );
    assert.match(buildStaticAudioUrl({ ...base, isEmby: true }), /&api_key=t%20k$/);
});
