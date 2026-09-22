import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('PlaybackStopReporting: ApiClient reportPlaybackStopped structure and fallback', () => {
    // Read ApiClient source code directly to inspect network call configurations
    const apiSource = readFileSync(
        new URL('../src/api/ApiClient.js', import.meta.url),
        'utf8'
    );

    // Verify reportPlaybackStopped signature accepts info and options
    assert.ok(
        apiSource.includes('async reportPlaybackStopped(info, options = {})'),
        'ApiClient must define reportPlaybackStopped with optional options parameter'
    );

    // Verify reportPlaybackStopped passes options cleanly without hardcoded keepalive: true
    assert.ok(
        apiSource.includes("return this.post('/Sessions/Playing/Stopped', info, options);"),
        'ApiClient must not force keepalive: true on reportPlaybackStopped'
    );

    // Verify request() has graceful fallback for keepalive failures
    // (Specifically for Chromium 69 / Tizen 5.5 where CORS preflight rejects keepalive)
    assert.ok(
        apiSource.includes('fetchOptions.keepalive && fetchErr instanceof TypeError'),
        'ApiClient request() must detect keepalive TypeError failures and retry without keepalive'
    );
});

test('PlaybackStopReporting: PlayerPage provides XHR fallback on async stop failures', () => {
    // Read PlayerPage source code to verify stop reporting resilience
    const playerSource = readFileSync(
        new URL('../src/pages/PlayerPage.js', import.meta.url),
        'utf8'
    );

    // Verify _reportPlaybackStopped catches async failure and falls back to synchronous XHR
    assert.ok(
        playerSource.includes('await api.reportPlaybackStopped(data);'),
        'PlayerPage must call api.reportPlaybackStopped in async path'
    );

    // Ensure synchronous XHR fallback is present if async reporting fails
    assert.ok(
        playerSource.includes('Async stop report failed, executing synchronous XHR fallback:'),
        'PlayerPage must log and trigger synchronous XHR fallback if async stop reporting fails'
    );

    // Ensure fallback dispatches to Sessions/Playing/Stopped endpoint
    assert.ok(
        playerSource.includes('const url = `${api.serverUrl}/Sessions/Playing/Stopped`;'),
        'PlayerPage must construct stop reporting URL for fallback'
    );
});
