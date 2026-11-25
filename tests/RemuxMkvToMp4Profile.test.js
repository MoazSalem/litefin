import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Provide minimal browser globals before importing BaseProfile (via PlayerSettings -> Logger)
globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
};

const { BaseProfile } = await import('../src/api/profiles/BaseProfile.js');

test('BaseProfile.stripMkvContainerFromProfiles strips mkv from both DirectPlayProfiles and DirectStreamProfiles', () => {
    // Simulate a WebOS-like device profile where DirectStreamProfiles declares 'mkv'
    const webosLikeProfile = {
        DirectPlayProfiles: [
            { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: 'h264,hevc' },
            { Container: 'mkv', Type: 'Video', VideoCodec: 'h264,hevc' },
            { Container: 'mp4,mkv,webm', Type: 'Video', VideoCodec: 'vp9' }
        ],
        DirectStreamProfiles: [
            { Container: 'mkv', Type: 'Video', VideoCodec: 'h264,hevc' }
        ]
    };

    BaseProfile.stripMkvContainerFromProfiles(webosLikeProfile);

    // DirectPlayProfiles: 'mkv'-only entry removed, mixed entry has 'mkv' stripped
    assert.deepEqual(
        webosLikeProfile.DirectPlayProfiles.map((p) => p.Container),
        ['mp4,m4v,mov', 'mp4,webm'],
        'DirectPlayProfiles must drop mkv-only entries and strip mkv from comma-separated lists'
    );

    // DirectStreamProfiles: 'mkv'-only entry removed so server falls through to TranscodingProfiles
    assert.deepEqual(
        webosLikeProfile.DirectStreamProfiles,
        [],
        'DirectStreamProfiles must also have mkv stripped so webOS falls through to HLS remuxing'
    );
});

test('BaseProfile.stripMkvContainerFromProfiles preserves mp4 in DirectStreamProfiles (Tizen/Android)', () => {
    const tizenLikeProfile = {
        DirectPlayProfiles: [
            { Container: 'mkv,mp4', Type: 'Video', VideoCodec: 'h264,hevc' }
        ],
        DirectStreamProfiles: [
            { Container: 'mp4', Type: 'Video', VideoCodec: 'h264,hevc' }
        ]
    };

    BaseProfile.stripMkvContainerFromProfiles(tizenLikeProfile);

    assert.equal(tizenLikeProfile.DirectPlayProfiles[0].Container, 'mp4');
    assert.equal(tizenLikeProfile.DirectStreamProfiles[0].Container, 'mp4');
});

test('JellyfinPlayer and PrewarmManager enforce MKV stripping on both DirectPlay and DirectStream profiles', () => {
    const playerSource = readFileSync(
        new URL('../src/player/core/JellyfinPlayer.js', import.meta.url),
        'utf8'
    );
    const prewarmSource = readFileSync(
        new URL('../src/player/core/PrewarmManager.js', import.meta.url),
        'utf8'
    );

    assert.ok(
        playerSource.includes('BaseProfile.stripMkvContainerFromProfiles(requestBody.DeviceProfile)'),
        'JellyfinPlayer._getPlaybackInfo must strip MKV from both DirectPlayProfiles and DirectStreamProfiles'
    );
    assert.ok(
        prewarmSource.includes('BaseProfile.stripMkvContainerFromProfiles(deviceProfile)'),
        'PrewarmManager must strip MKV from both DirectPlayProfiles and DirectStreamProfiles'
    );
    assert.ok(
        playerSource.includes("this._playbackMode !== 'directPlay'") &&
        playerSource.includes('firstSource.SupportsDirectStream && !firstSource.TranscodingUrl'),
        'JellyfinPlayer must discard cached prewarmed DirectPlay/raw-DirectStream MKV responses when remuxMkvToMp4 is enabled'
    );
});
