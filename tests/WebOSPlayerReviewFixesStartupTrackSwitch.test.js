import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: a failed audio track switch at startup is reported after
 * play() has resolved
 * ============================================================================
 * webOS does not list the audio tracks of a progressive MKV/MP4, so a
 * preferred track that is not the file's default cannot be switched to, and
 * JellyfinPlayer restarts the item as a remux on 'audiotrackswitchfailed'.
 * Sent while play() was still pending, that restart cancelled the play().
 * ============================================================================
 */

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

/** Chromium resolves video.play() only once playback has started, some time later */
const PLAY_DELAY_MS = 20;

function createVideo() {
    return createEventTarget({
        children: [],
        style: {},
        audioTracks: [], // webOS: none for progressive MKV/MP4
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        muted: false,
        paused: true,
        seeking: false,
        seekable: { length: 1 },
        buffered: { length: 0 },
        error: null,
        src: '',
        get firstChild() {
            return this.children[0] || null;
        },
        setAttribute() {},
        removeAttribute(name) {
            if (name === 'src') this.src = '';
        },
        appendChild(child) {
            this.children.push(child);
        },
        removeChild(child) {
            this.children = this.children.filter((c) => c !== child);
        },
        load() {},
        pause() {
            this.paused = true;
        },
        play() {
            this.paused = false;
            return new Promise((resolve) => setTimeout(resolve, PLAY_DELAY_MS));
        },
        canPlayType: () => ''
    });
}

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = createEventTarget({
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement: (tag) =>
        tag === 'video'
            ? createVideo()
            : createEventTarget({ classList: { add() {}, remove() {} }, style: {}, appendChild() {} })
});

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MKV whose default is English AAC; the user prefers the Japanese AC-3 track
const options = {
    url: 'http://srv/Videos/a/stream.mkv?Static=true',
    mediaSource: {
        Container: 'mkv',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'h264' },
            { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2, IsDefault: true },
            { Index: 2, Type: 'Audio', Codec: 'ac3', Language: 'jpn', Channels: 6, IsDefault: false }
        ]
    },
    audioStreamIndex: 2,
    audioTrackListIndex: 1
};

function createPlayer(onEvent) {
    const player = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: (e) => onEvent(e, player)
    });
    return player;
}

test('WebOSPlayer: the startup audiotrackswitchfailed arrives only after play() has resolved', async () => {
    let settled = false;
    const reports = [];
    const player = createPlayer((e, p) => {
        if (e.type !== 'audiotrackswitchfailed') return;
        reports.push({ settled, data: e.data });
        p.stop(); // what JellyfinPlayer's restart does first
    });

    const playing = player.play(options);
    const outcome = playing.then(
        () => 'resolved',
        (err) => err
    );
    playing.then(
        () => (settled = true),
        () => (settled = true)
    );
    await flush();
    player._videoElement.fire('canplay');
    await wait(PLAY_DELAY_MS * 3);

    assert.deepStrictEqual(reports, [{ settled: true, data: { listIndex: 1 } }]);
    assert.strictEqual(await outcome, 'resolved', 'the restart cancelled the first play()');
});

test('WebOSPlayer: a startup audio track failure of a play() cancelled before it resolved is not reported', async () => {
    const reports = [];
    const player = createPlayer((e) => {
        if (e.type === 'audiotrackswitchfailed') reports.push(e.data);
    });

    const playing = player.play(options);
    playing.catch(() => {});
    await flush();
    player._videoElement.fire('canplay');
    await flush();
    await player.stop(); // Back while video.play() is still pending
    await wait(PLAY_DELAY_MS * 3);

    assert.deepStrictEqual(reports, []);
});

test('WebOSPlayer: the default track is not heard before the restart takes over', async () => {
    const mutedAtEvent = [];
    const player = createPlayer((e, p) => {
        if (e.type !== 'audiotrackswitchfailed') return;
        mutedAtEvent.push(p._videoElement.muted);
        p.stop();
    });

    const playing = player.play(options);
    playing.catch(() => {});
    await flush();
    const video = player._videoElement;
    video.fire('canplay');
    await flush();
    assert.strictEqual(video.muted, true, 'the default track plays until the restart');
    video.fire('playing');
    assert.strictEqual(video.muted, true, "unmuted at 'playing'");

    await wait(PLAY_DELAY_MS * 3);
    assert.deepStrictEqual(mutedAtEvent, [true]);
    assert.strictEqual(video.muted, false, "the restart's stop() left the element muted");
});

test('WebOSPlayer: a resume keeps the default track muted past playing until the restart', async () => {
    let restarted = false;
    const player = createPlayer((e, p) => {
        if (e.type !== 'audiotrackswitchfailed') return;
        restarted = true;
        p.stop();
    });

    const playing = player.play({ ...options, playerStartPositionTicks: 6000000000 });
    playing.catch(() => {});
    await flush();
    const video = player._videoElement;
    video.fire('canplay');
    await flush();
    video.fire('seeked'); // the resume seek to 10:00 landed
    await flush();
    video.fire('playing');
    assert.strictEqual(video.muted, true, "the resume mute was lifted at 'playing'");

    await wait(PLAY_DELAY_MS * 3);
    assert.strictEqual(restarted, true);
    assert.strictEqual(video.muted, false);
});

test('WebOSPlayer: without a restart the mute is lifted after 5 s, and a mute of the user stays', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const userMuted of [false, true]) {
        const player = createPlayer(() => {}); // nothing restarts the item
        const video = player._ensureVideoElement();
        video.muted = userMuted;

        const playing = player.play(options);
        await flush();
        video.fire('canplay');
        await flush();
        t.mock.timers.tick(PLAY_DELAY_MS);
        await playing;
        video.fire('playing');
        t.mock.timers.tick(4999);
        assert.strictEqual(video.muted, true);
        t.mock.timers.tick(1);
        assert.strictEqual(video.muted, userMuted, userMuted ? "the user's mute was lifted" : 'silent for good');
        await player.stop();
    }
});
