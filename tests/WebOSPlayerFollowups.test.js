import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player Follow-up Test Suite
 * ============================================================================
 * Smaller fixes in the native webOS player:
 *   - the video box is written only when it changes (A8)
 *   - one TV video-window request at a time, with a slower refresh (A8)
 *   - canPlayType probes are not repeated on every play (A8)
 *   - a failed backward seek is detected (A9)
 *   - native subtitle tracks stay off and cue offsets never double (A9)
 *   - per-item state does not carry over to the next item (A9)
 *   - no temporary multi-line audio debug dumps (A9)
 *   - a 'stalled' download pause with a full buffer is not a stall (D2)
 *   - Play after a seek that never reports 'seeked' still starts playback (D7)
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Minimal DOM: <video>/<source> stand-ins that can fire events
// ----------------------------------------------------------------------------

const GEOMETRY_KEYS = ['position', 'margin', 'left', 'top', 'right', 'bottom', 'width', 'height', 'objectFit', 'objectPosition'];

/** Inline style stand-in that counts writes of the video box geometry */
function createStyle() {
    let geometryWrites = 0;
    return new Proxy({}, {
        get: (target, key) => (key === 'geometryWrites' ? geometryWrites : target[key]),
        set(target, key, value) {
            if (GEOMETRY_KEYS.includes(key)) geometryWrites++;
            target[key] = value;
            return true;
        }
    });
}

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        listenerCount: (type) => (listeners[type] || []).length,
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

function createVideo() {
    const video = createEventTarget({
        tagName: 'VIDEO',
        children: [],
        style: createStyle(),
        parentNode: null,
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        muted: false,
        paused: true,
        seeking: false,
        videoWidth: 1920,
        videoHeight: 1080,
        volume: 1,
        seekable: { length: 1 },
        buffered: { length: 0 },
        error: null,
        src: '',
        playCalls: 0,
        get firstChild() {
            return this.children[0] || null;
        },
        setAttribute() {},
        removeAttribute(name) {
            if (name === 'src') this.src = '';
        },
        appendChild(child) {
            child.parentNode = this;
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
            this.playCalls++;
            this.paused = false;
            return Promise.resolve();
        },
        canPlayType: () => ''
    });
    return video;
}

const createdVideos = [];
const documentTarget = createEventTarget({});

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = Object.assign(documentTarget, {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement(tag) {
        if (tag === 'video') {
            const video = createVideo();
            createdVideos.push(video);
            return video;
        }
        if (tag === 'source') return createEventTarget({ tagName: 'SOURCE', src: '', type: '' });
        return {
            classList: { add() {}, remove() {}, toggle() {} },
            style: {},
            addEventListener() {},
            querySelectorAll: () => [],
            appendChild() {},
            canPlayType: () => '',
            innerHTML: ''
        };
    }
});
globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U\n' });

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');
const { platformInfo } = await import('../src/utils/PlatformInfo.js');
const { logger } = await import('../src/utils/Logger.js');
const { eventBus } = await import('../src/core/EventBus.js');

const mediaSource = {
    Container: 'mkv',
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2, IsDefault: true }
    ]
};
// Native-only HLS (HEVC HDR + E-AC-3): Hls.js cannot take over
const nativeOnlyHls = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'hevc', VideoRangeType: 'HDR10' },
        { Index: 1, Type: 'Audio', Codec: 'eac3', IsDefault: true }
    ]
};

function createPlayer() {
    const container = {
        clientWidth: 1920,
        clientHeight: 1080,
        style: {},
        children: [],
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
        },
        removeChild(child) {
            child.parentNode = null;
            this.children = this.children.filter((c) => c !== child);
        }
    };
    const events = [];
    const player = new WebOSPlayer({ container, onEvent: (e) => events.push(e.type) });
    return { player, events, container };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** play() and let the load reach 'canplay' */
async function playAndStart(player, options) {
    const playing = player.play(options);
    await flush();
    player._videoElement.fire('canplay');
    await playing;
}


// ----------------------------------------------------------------------------
// A8 — layout and Luna churn
// ----------------------------------------------------------------------------

test('WebOSPlayer: the video box is written only when it changes', async () => {
    const { player, container } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    const video = player._videoElement;
    video.fire('loadedmetadata');
    const style = video.style;
    assert.strictEqual(style.width, '1920px');
    const written = style.geometryWrites;

    // Every seek, unpause and rebuffer fires 'playing' (and a seek also refits from 'seeked')
    for (let i = 0; i < 5; i++) video.fire('playing');
    video.fire('resize');
    assert.strictEqual(style.geometryWrites, written, 'unchanged video box written again');

    container.clientWidth = 1280;
    container.clientHeight = 720;
    player._fitVideoBox();
    assert.strictEqual(style.width, '1280px');
    assert.strictEqual(style.height, '720px');

    player.setAspectRatio('stretch');
    assert.strictEqual(style.objectFit, 'fill');
    assert.strictEqual(style.right, '0px');
    player.setAspectRatio('auto');
    assert.strictEqual(style.objectFit, 'contain');
    assert.strictEqual(style.right, '');

    // The next item on the same element keeps a correct box
    await player.stop();
    await playAndStart(player, { url: 'http://srv/Videos/b/stream.mkv', mediaSource });
    player._videoElement.videoWidth = 1440;
    player._videoElement.fire('loadedmetadata');
    assert.strictEqual(player._videoElement.style.width, '960px');
    assert.strictEqual(player._videoElement.style.left, '160px');
});

/** Old webOS (Chromium < 79) with the Luna bridge: aspect modes go through the TV's video output service */
function useLunaOutputWindow(t) {
    const pending = [];
    const sent = [];
    globalThis.window.PalmServiceBridge = class {
        call(uri, params) {
            sent.push({ uri, params: JSON.parse(params) });
            pending.push(this);
        }
        cancel() {}
    };
    const chromeVersion = platformInfo._chromeVersion;
    platformInfo._chromeVersion = 68;
    t.after(() => {
        platformInfo._chromeVersion = chromeVersion;
        delete globalThis.window.PalmServiceBridge;
    });
    return {
        sent,
        pending,
        async replyAll(reply = { returnValue: true }) {
            while (pending.length) pending.shift().onservicecallback(JSON.stringify(reply));
            for (let i = 0; i < 4; i++) await flush();
        }
    };
}

async function zoomedPlayback(player) {
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    const video = player._videoElement;
    video.mediaId = 'pipeline-1';
    video.videoWidth = 1920;
    video.videoHeight = 800;
    player._aspectMode = 'zoom';
    return video;
}

test('WebOSPlayer: one TV video-window request at a time', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const luna = useLunaOutputWindow(t);
    const { player } = createPlayer();
    const video = await zoomedPlayback(player);

    // loadedmetadata, canplay and playing each refit while the first request is in flight
    player._fitVideoBox();
    video.fire('playing');
    video.fire('resize');
    assert.strictEqual(luna.sent.length, 1, 'concurrent setDisplayWindow requests');

    await luna.replyAll();
    assert.strictEqual(luna.sent.length, 2, 'the refits made meanwhile are sent once, afterwards');
    await luna.replyAll();
    assert.strictEqual(luna.sent.length, 2);
    assert.strictEqual(luna.sent[1].uri, 'luna://com.webos.service.videooutput/display/setDisplayWindow');
    await player.stop();
});

test('WebOSPlayer: an accepted TV video window is refreshed every 30 s once settled', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const luna = useLunaOutputWindow(t);
    const { player } = createPlayer();
    await zoomedPlayback(player);
    player._fitVideoBox();
    await luna.replyAll();

    let sentAfterOneMinute = 0;
    for (let s = 1; s <= 120; s++) {
        t.mock.timers.tick(1000);
        await luna.replyAll();
        if (s === 60) sentAfterOneMinute = luna.sent.length;
    }
    // Was every 3 s for the whole playback: 20 Luna calls a minute
    assert.ok(luna.sent.length - sentAfterOneMinute <= 2, `${luna.sent.length - sentAfterOneMinute} refreshes in the second minute`);
    assert.ok(luna.sent.length >= 6, 'the first refreshes still come every 3 s');
    await player.stop();
});

test('WebOSPlayer: canPlayType is asked once per MIME type, not on every play', async () => {
    // The Dolby Vision direct-play path probes 'video/mp4; codecs="dvh1"' before each load
    const doviSource = {
        Container: 'mp4',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'hevc', VideoRangeType: 'DOVI' },
            { Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true }
        ]
    };
    const { player } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource: doviSource });
    const created = createdVideos.length;
    await player.stop();
    await playAndStart(player, { url: 'http://srv/Videos/b/stream.mp4', mediaSource: doviSource });
    await player.stop();
    await playAndStart(player, { url: 'http://srv/Videos/c/stream.mp4', mediaSource: doviSource });
    assert.strictEqual(createdVideos.length, created, 'a throw-away <video> per play');
});

// ----------------------------------------------------------------------------
// A9 — smaller correctness issues
// ----------------------------------------------------------------------------

async function directPlayStarted(player) {
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    player._started = true;
    return player._videoElement;
}

test('WebOSPlayer: a direct-play seek backwards that does not land is retried', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const video = await directPlayStarted(player);
    const retries = [];
    player._seekWithRetry = (time) => retries.push(time);

    video.currentTime = 1200;
    player.seek(100 * 10000000);
    video.currentTime = 1202.5; // the demuxer stayed put and played on
    t.mock.timers.tick(2500);
    assert.deepStrictEqual(retries, [100], 'a position past the target was taken for a landed seek');

    // A seek that landed and played on is left alone
    player.seek(100 * 10000000);
    video.currentTime = 102.5;
    t.mock.timers.tick(2500);
    assert.deepStrictEqual(retries, [100]);
    await player.stop();
});

function nativeTextTracks() {
    const track = () => ({ mode: 'disabled', cues: [{ startTime: 10, endTime: 12 }] });
    return [track(), track()];
}

test('WebOSPlayer: switching subtitle tracks and back does not double the cue offset', async () => {
    const { player } = createPlayer();
    const video = await directPlayStarted(player);
    const tracks = nativeTextTracks();
    video.textTracks = tracks;

    player.setSubtitleStreamIndex(0);
    player.setSubtitleOffset(2);
    assert.strictEqual(tracks[0].cues[0].startTime, 12);

    player.setSubtitleStreamIndex(1);
    player.setSubtitleStreamIndex(0);
    assert.strictEqual(tracks[0].cues[0].startTime, 10, 'the switch reset the offset but left the cues moved');
    player.setSubtitleOffset(2);
    assert.strictEqual(tracks[0].cues[0].startTime, 12, 'offset applied twice');
    assert.strictEqual(tracks[0].cues[0].endTime, 14);
    await player.stop();
});

test('WebOSPlayer: native subtitle tracks are turned off, not left loading', async () => {
    const { player } = createPlayer();
    const video = await directPlayStarted(player);
    const tracks = nativeTextTracks();
    tracks[0].mode = 'showing';
    video.textTracks = tracks;

    player.setSubtitleStreamIndex(-1); // SubtitleManager renders
    assert.deepStrictEqual(tracks.map((t) => t.mode), ['disabled', 'disabled']);
    await player.stop();
});

test('WebOSPlayer: a Jellyfin subtitle index never selects an Hls.js subtitle rendition', async () => {
    const { player } = createPlayer();
    await directPlayStarted(player);
    const hls = { audioTracks: [], subtitleTracks: [{}, {}, {}, {}], subtitleTrack: -1 };
    // Stream 3 is an external .srt that SubtitleManager renders; rendition 3 is something else
    player._applyInitialTracks({ mediaSource, subtitleStreamIndex: 3 }, hls);
    assert.strictEqual(hls.subtitleTrack, -1);
    await player.stop();
});

test('WebOSPlayer: one rejected TV video window does not switch it off for later items', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const luna = useLunaOutputWindow(t);
    const { player } = createPlayer();
    const rejectedItem = async () => {
        await zoomedPlayback(player);
        player._outputWindowFailures = 4; // the fifth rejection gives up on this item
        player._fitVideoBox();
        await luna.replyAll({ returnValue: false });
        assert.strictEqual(player._outputWindowState, 'failed');
        await player.stop();
    };

    await rejectedItem();
    assert.ok(player._canUseOutputWindow(), 'one rejected item turned the TV video window off for the app session');
    await rejectedItem();
    assert.ok(!player._canUseOutputWindow(), 'tried again on every item although the TV keeps rejecting it');
});

test('WebOSPlayer: a stall recovery kick on one item does not hold back recovery on the next', async () => {
    const { player } = createPlayer();
    await directPlayStarted(player);
    player._lastRecoveryKickTime = Date.now();
    await player.stop();
    assert.strictEqual(player._lastRecoveryKickTime, 0);
});

test('WebOSPlayer: audio track diagnostics are one debug line per step, not multi-line info dumps', async (t) => {
    const lines = [];
    const onLog = (entry) => {
        if (entry.module === 'WebOSPlayer') lines.push({ level: entry.level, text: String(entry.args[0]) });
    };
    const consoleLog = console.log;
    console.log = () => {};
    logger.setEnabled(true);
    eventBus.on('logger:log', onLog);
    t.after(() => {
        eventBus.off('logger:log', onLog);
        logger.setEnabled(false);
        console.log = consoleLog;
    });

    const { player } = createPlayer();
    const video = await directPlayStarted(player);
    video.audioTracks = [
        { id: '1', language: 'eng', label: 'English', enabled: true },
        { id: '2', language: 'bul', label: 'Bulgarian', enabled: false }
    ];
    player._applyInitialTracks({ mediaSource, audioStreamIndex: 1, audioTrackListIndex: 0 }, null);
    player._resolveNativeAudioIndex(0);
    await player.stop();

    const fragments = lines.filter((l) => /^\s+[-*] /.test(l.text));
    assert.deepStrictEqual(fragments.map((l) => l.text), [], 'one log line per track and field');
    assert.ok(!lines.some((l) => l.text.includes('[AudioDebug]')));
});

// ----------------------------------------------------------------------------
// D2 — 'stalled' with a full buffer
// ----------------------------------------------------------------------------

function bufferedAhead(video, seconds) {
    video.buffered = { length: 1, start: () => 0, end: () => video.currentTime + seconds };
}

test('WebOSPlayer: a stalled download with a full buffer is not reported as buffering', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    const video = await directPlayStarted(player);
    video.currentTime = 600;
    video.readyState = 4;
    bufferedAhead(video, 45);
    events.length = 0;

    // LG C4: 'stalled' every ~6 s with 45 s buffered while playback runs on
    video.fire('stalled');
    assert.ok(!events.includes('waiting'), 'buffering reported (PlayerPage pings the server 3.5 s later)');

    // A real underrun still is
    bufferedAhead(video, 0.4);
    video.readyState = 2;
    video.fire('stalled');
    assert.ok(events.includes('waiting'));
    await player.stop();
});

// ----------------------------------------------------------------------------
// D7 — Play after a seek that never reports 'seeked'
// ----------------------------------------------------------------------------

test('WebOSPlayer: Play after a seek that never reports seeked still starts playback', async (t) => {
    // LG C4, paused native-HLS remux: the seek completes only once playback starts
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const video = await directPlayStarted(player);
    video.paused = true;
    const plays = video.playCalls;

    video.seeking = true;
    player.unpause();
    assert.strictEqual(video.playCalls, plays, 'played the stale pre-seek frames straight away');
    t.mock.timers.tick(400);
    assert.strictEqual(video.playCalls, plays, 'no time for a seek that lands');
    t.mock.timers.tick(100);
    assert.strictEqual(video.playCalls, plays + 1, 'Play queued for a seeked event that never comes');

    // A seek that lands in time plays once, on 'seeked'
    video.seeking = true;
    player.unpause();
    video.seeking = false;
    video.fire('seeked');
    t.mock.timers.tick(1000);
    assert.strictEqual(video.playCalls, plays + 2);

    // Pressing Play again while it is queued starts it at once
    video.seeking = true;
    player.unpause();
    player.unpause();
    assert.strictEqual(video.playCalls, plays + 3);
    t.mock.timers.tick(1000);
    assert.strictEqual(video.playCalls, plays + 3);

    // An explicit pause cancels the queued play
    player.unpause();
    player.pause();
    t.mock.timers.tick(1000);
    assert.strictEqual(video.playCalls, plays + 3);
    await player.stop();
});

test('WebOSPlayer: a Pause that cancels a play queued behind a seek reports the pause', async (t) => {
    // LG C4: the OSD queued Play after a scrub; the user's next press (taken for a
    // pause, as playback counted as resumed) cancelled it on the paused element.
    // No 'pause' event came, so every later press was a pause as well.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    const video = await directPlayStarted(player);
    video.paused = true;
    video.seeking = true;
    player.unpause();
    events.length = 0;

    player.pause();
    assert.deepStrictEqual(events, ['pause']);
    t.mock.timers.tick(1000);
    assert.strictEqual(video.paused, true, 'the cancelled play started anyway');

    // A pause of a paused element with nothing queued reports nothing (guard)
    events.length = 0;
    player.pause();
    assert.deepStrictEqual(events, []);
    await player.stop();
});

// ----------------------------------------------------------------------------
// D11 — a seek the pipeline never completes
// ----------------------------------------------------------------------------

/** Advance mock time in check-sized steps (a timer set inside a tick waits for the next tick). */
function advance(t, ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += 2000) t.mock.timers.tick(2000);
}

/** Started direct play whose events (with data) are collected. */
async function watchedPlayback(player) {
    const video = await directPlayStarted(player);
    const seen = [];
    const forward = player.onEvent;
    player.onEvent = (e) => {
        seen.push(e);
        forward(e);
    };
    video.buffered = { length: 1, start: () => 0, end: () => 47 };
    return { video, stuck: () => seen.filter((e) => e.type === 'seekstuck') };
}

test('WebOSPlayer: a seek still pending 8 s into playback with no new data asks for a reload at its target', async (t) => {
    // LG C4: after a rejected seek the next one never completed; the element stayed
    // 'seeking' at the target with playback requested and the buffer unchanged
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const { video, stuck } = await watchedPlayback(player);

    video.seeking = true;
    video.paused = false;
    video.currentTime = 60;
    video.fire('seeking');
    advance(t, 6000);
    assert.strictEqual(stuck().length, 0, 'gave up on a seek that may still land');
    advance(t, 2000);
    assert.deepStrictEqual(stuck().map((e) => e.data.targetPositionTicks), [600000000]);

    advance(t, 30000);
    assert.strictEqual(stuck().length, 1, 'reported more than once');
    await player.stop();
});

test('WebOSPlayer: a paused seek, a seek receiving data and a seek that lands are not reported early', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const { video, stuck } = await watchedPlayback(player);

    // Paused: webOS completes the seek only once playback starts
    video.seeking = true;
    video.paused = true;
    video.fire('seeking');
    advance(t, 60000);
    assert.strictEqual(stuck().length, 0, 'counted a paused seek');

    // Playing and receiving data (a slow 4K remux seek): waits up to 30 s
    video.paused = false;
    video.fire('play');
    let end = 47;
    for (let elapsed = 0; elapsed < 28000; elapsed += 2000) {
        end += 3;
        video.buffered = { length: 1, start: () => 0, end: () => end };
        t.mock.timers.tick(2000);
    }
    assert.strictEqual(stuck().length, 0, 'gave up on a seek still receiving data');
    t.mock.timers.tick(2000);
    assert.strictEqual(stuck().length, 1, 'no limit for a seek that never lands');

    // A seek that lands ends the watch
    video.fire('seeking');
    advance(t, 4000);
    video.seeking = false;
    video.fire('seeked');
    advance(t, 60000);
    assert.strictEqual(stuck().length, 1);
    await player.stop();
});

test('WebOSPlayer: stop() ends the seek watch', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const { video, stuck } = await watchedPlayback(player);
    video.seeking = true;
    video.paused = false;
    video.fire('seeking');
    await player.stop();
    advance(t, 60000);
    assert.strictEqual(stuck().length, 0);
});
