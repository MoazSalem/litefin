import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('PlayerPage: pause heartbeat timer and payload optimization integrity', () => {
    const source = readFileSync(
        new URL('../src/pages/PlayerPage.js', import.meta.url),
        'utf8'
    );

    // 1. Pause report timer calls _reportPlaybackProgress('pause_heartbeat')
    assert.match(
        source,
        /_reportPlaybackProgress\('pause_heartbeat'\)/,
        'Pause report timer must call _reportPlaybackProgress with pause_heartbeat'
    );

    // 2. NowPlayingQueue is omitted for timeupdate and pause_heartbeat
    assert.match(
        source,
        /if\s*\(eventName !== 'timeupdate' && eventName !== 'pause_heartbeat'\)\s*\{\s*info\.NowPlayingQueue = this\._buildNowPlayingQueue\(\);/m,
        'NowPlayingQueue must not be attached on routine pause_heartbeat or timeupdate'
    );

    // 3. EventName for pause_heartbeat is normalized to timeupdate
    assert.match(
        source,
        /EventName:\s*eventName === 'pause_heartbeat' \? 'timeupdate' : eventName/,
        'EventName for pause_heartbeat must map to timeupdate for Jellyfin API'
    );
});
