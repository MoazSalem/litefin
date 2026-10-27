import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * HtmlVideoPlayer Lifecycle Test Suite
 * ============================================================================
 * The HTML5 backend (used on LG for "Retry with HTML5") reuses one <video>
 * across items. Timers and one-shot listeners of a playback must end with
 * stop() / the next play(), or they act on the next item. HLS.js recovery
 * is bounded and failures are reported instead of looping. Audio
 * normalization keeps working across queued items.
 * ============================================================================
 */

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
    return createEventTarget({
        style: {},
        children: [],
        parentNode: null,
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        muted: false,
        paused: true,
        seeking: false,
        error: null,
        src: '',
        playCalls: 0,
        firstChild: null,
        setAttribute() {},
        removeAttribute(name) {
            if (name === 'src') this.src = '';
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
}

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = createEventTarget({
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement: (tag) => (tag === 'video' ? createVideo() : { style: {}, canPlayType: () => '', appendChild() {} })
});
globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U\n' });

const { HtmlVideoPlayer } = await import('../src/player/core/HtmlVideoPlayer.js');
const { platformInfo } = await import('../src/utils/PlatformInfo.js');
const { default: Hls } = await import('hls.js');

const mediaSource = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true }
    ]
};

function createPlayer() {
    const events = [];
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
    const player = new HtmlVideoPlayer({ container, onEvent: (e) => events.push(e.type) });
    return { player, events, container };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function playAndStart(player, options) {
    const playing = player.play(options);
    await flush();
    await flush();
    player._videoElement.fire('canplay');
    await playing;
}

test('HtmlVideoPlayer: a direct-play seek check does not fire after stop()', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mkv', mediaSource, item: { Type: 'Movie' } });

    player.seek(600 * 10000000); // user seeks to 10:00
    await player.stop(); // ...and backs out / the next episode starts
    player._videoElement.currentTime = 0;

    t.mock.timers.tick(3000);
    assert.ok(!events.includes('resumeseekfailed'), 'would restart the next item at the old position');
});

test('HtmlVideoPlayer: HLS seeks are not verified like progressive direct play', async (t) => {
    const { player, events } = createPlayer();
    await playAndStart(player, { url: 'http://srv/videos/a/master.m3u8', isHls: true, mediaSource, item: { Type: 'Movie' } });
    assert.strictEqual(player._isHls, true);

    t.mock.timers.enable({ apis: ['setTimeout'] });
    player.seek(600 * 10000000);
    player._videoElement.currentTime = 0; // segment still loading
    t.mock.timers.tick(3000);
    assert.ok(!events.includes('resumeseekfailed'));
});

test('HtmlVideoPlayer: a load abandoned by stop() rejects and never acts on the next item', async () => {
    const { player } = createPlayer();
    const playA = player.play({ url: 'http://srv/Videos/a/stream.mkv', mediaSource, playerStartPositionTicks: 6000000000 });
    await flush();
    await player.stop();
    await assert.rejects(playA, (err) => err.name === 'AbortError' && err.superseded === true);

    await playAndStart(player, { url: 'http://srv/Videos/b/stream.mkv', mediaSource });
    const video = player._videoElement;
    assert.strictEqual(video.playCalls, 1);
    assert.strictEqual(video.currentTime, 0, 'item A\'s resume seek ran on item B');
    assert.strictEqual(video.listenerCount('canplay'), 0);
});

test('HtmlVideoPlayer: the resume follow-up check is cleared by stop()', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();
    player._currentPlayOptions = { mediaSource };

    player._applyPlaybackResume(video, { playerStartPositionTicks: 6000000000 });
    await player.stop();
    video.currentTime = 0;
    t.mock.timers.tick(3000);

    assert.ok(!events.includes('resumeseekfailed'));
});

// ----------------------------------------------------------------------------
// HLS.js recovery
// ----------------------------------------------------------------------------

function createFakeHls() {
    const calls = [];
    return {
        calls,
        startLoad: () => calls.push('startLoad'),
        recoverMediaError: () => calls.push('recoverMediaError'),
        swapAudioCodec: () => calls.push('swapAudioCodec')
    };
}

const fatal = (type, details, extra = {}) => ({ fatal: true, type, details, ...extra });

test('HtmlVideoPlayer: fatal HLS.js network errors are retried with backoff, then reported', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const hls = createFakeHls();
    player._hlsPlayer = hls;
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    const networkError = fatal(Hls.ErrorTypes.NETWORK_ERROR, 'fragLoadError');

    for (const delay of [1000, 2000, 4000]) {
        onError('hlsError', networkError);
        const before = hls.calls.length;
        t.mock.timers.tick(delay - 1);
        assert.strictEqual(hls.calls.length, before, `startLoad() before ${delay} ms`);
        t.mock.timers.tick(1);
        assert.strictEqual(hls.calls.length, before + 1, `no startLoad() after ${delay} ms`);
    }
    onError('hlsError', networkError);
    assert.strictEqual(failures.length, 1, 'retried forever');
    assert.strictEqual(failures[0].isNetworkError, true);
});

test('HtmlVideoPlayer: an HTTP error is not retried, and a loaded fragment resets the retry budget', () => {
    const { player } = createPlayer();
    const hls = createFakeHls();
    const failures = [];
    const handler = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    handler.onError('hlsError', fatal(Hls.ErrorTypes.NETWORK_ERROR, 'manifestLoadError', { response: { code: 500 } }));
    assert.strictEqual(failures.length, 1);
    assert.match(failures[0].message, /HTTP 500/);

    const other = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    for (let i = 0; i < 3; i++) other.onError('hlsError', fatal(Hls.ErrorTypes.NETWORK_ERROR, 'fragLoadError'));
    other.onFragLoaded();
    other.onError('hlsError', fatal(Hls.ErrorTypes.NETWORK_ERROR, 'fragLoadError'));
    assert.strictEqual(failures.length, 1);
});

test('HtmlVideoPlayer: fatal HLS.js media errors get a decoder reset, then a codec swap, then are reported', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const { player } = createPlayer();
    const hls = createFakeHls();
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    const mediaError = fatal(Hls.ErrorTypes.MEDIA_ERROR, 'bufferAppendError');

    t.mock.timers.tick(10000);
    onError('hlsError', mediaError);
    onError('hlsError', mediaError);
    assert.deepStrictEqual(hls.calls, ['recoverMediaError', 'swapAudioCodec', 'recoverMediaError']);
    onError('hlsError', mediaError);
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].code, 3);
});

test('HtmlVideoPlayer: non-fatal HLS.js errors add no extra loads on top of HLS.js retries', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const hls = createFakeHls();
    player._hlsPlayer = hls;
    const { onError } = player._createHlsErrorHandler(hls, () => {});
    onError('hlsError', { fatal: false, type: Hls.ErrorTypes.NETWORK_ERROR, details: 'fragLoadError' });
    t.mock.timers.tick(5000);
    assert.deepStrictEqual(hls.calls, [], 'duplicate segment request to the transcoder');
});

test('HtmlVideoPlayer: a decode error during HLS.js playback gets the same bounded recovery', (t) => {
    // HLS.js only logs <video> errors, so the player must recover them itself
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.mock.timers.tick(10000);
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();
    const hls = createFakeHls();
    const failures = [];
    player._hlsPlayer = hls;
    const handling = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    player._hlsElementErrorHandler = { hls, onError: handling.onError };
    video.src = 'blob:hls';
    video.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' };

    player._onError({ target: video });
    assert.deepStrictEqual(hls.calls, ['recoverMediaError'], 'decode error not recovered in place');
    player._onError({ target: video });
    assert.deepStrictEqual(hls.calls, ['recoverMediaError', 'swapAudioCodec', 'recoverMediaError']);
    player._onError({ target: video });
    assert.strictEqual(failures.length, 1, 'a decoder that keeps failing must be reported');
    assert.ok(!events.includes('error'), 'reported twice');
});

// ----------------------------------------------------------------------------
// Audio normalization across items
// ----------------------------------------------------------------------------

class StrictAudioContext {
    static instances = [];
    constructor() {
        StrictAudioContext.instances.push(this);
        this.state = 'running';
        this.closed = false;
        this.destination = {};
    }
    createMediaElementSource(element) {
        if (element.webAudioSource) {
            throw new Error('InvalidStateError: element already connected to a MediaElementSourceNode');
        }
        element.webAudioSource = true;
        this.usedForMedia = true;
        return { connect() {}, disconnect() {} };
    }
    createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    close() {
        this.closed = true;
        return Promise.resolve();
    }
    suspend() {
        this.state = 'suspended';
        return Promise.resolve();
    }
    resume() {
        this.state = 'running';
        return Promise.resolve();
    }
}

// Contexts of the normalization graph (the codec capability probe creates and closes its own)
const mediaContexts = () => StrictAudioContext.instances.filter((c) => c.usedForMedia);

const track = (gainDb) => ({
    url: 'http://srv/Audio/1/stream.mp3',
    item: { MediaType: 'Audio', NormalizationGain: gainDb },
    mediaSource: {}
});
const movie = { url: 'http://srv/Videos/m/stream.mkv', item: { Type: 'Movie', MediaType: 'Video' }, mediaSource };

test('HtmlVideoPlayer: normalization works for every queued track and the next movie keeps its audio path', async () => {
    window.AudioContext = StrictAudioContext;
    StrictAudioContext.instances = [];
    const { player, container } = createPlayer();

    await playAndStart(player, track(-6));
    const firstElement = player._videoElement;
    assert.ok(Math.abs(player._audioGraph.gain.gain.value - 0.501) < 0.001);
    await player.stop();

    // The captured element is released with its graph; the context is kept
    assert.ok(!container.children.includes(firstElement));
    assert.strictEqual(mediaContexts()[0].closed, false);

    await playAndStart(player, track(-12));
    assert.ok(Math.abs(player._audioGraph.gain.gain.value - 0.251) < 0.001, 'second track not normalized');
    assert.notStrictEqual(player._videoElement, firstElement);
    await player.stop();

    await playAndStart(player, track(-3));
    await player.stop();

    // One context for the whole queue: Chromium 38 cannot close() contexts and
    // Chromium caps how many can exist
    assert.strictEqual(mediaContexts().length, 1, 'an AudioContext per track runs out on old TVs');
    assert.strictEqual(mediaContexts()[0].closed, false);

    await playAndStart(player, movie);
    assert.strictEqual(player._audioGraph, null);
    assert.ok(!player._videoElement.webAudioSource, 'movie element is routed into a closed AudioContext');
    delete window.AudioContext;
});

test('HtmlVideoPlayer: play() without stop() reuses the graph and plays a movie at unity gain', async () => {
    window.AudioContext = StrictAudioContext;
    StrictAudioContext.instances = [];
    const { player } = createPlayer();

    await playAndStart(player, track(-6));
    await playAndStart(player, movie);

    assert.strictEqual(mediaContexts().length, 1);
    assert.strictEqual(player._audioGraph.gain.gain.value, 1);
    delete window.AudioContext;
});

test('HtmlVideoPlayer: the user mute state survives the element swap', async () => {
    window.AudioContext = StrictAudioContext;
    const { player } = createPlayer();

    await playAndStart(player, track(-6));
    player._videoElement.muted = true;
    await player.stop();

    assert.strictEqual(player._videoElement.muted, true);
    delete window.AudioContext;
});

test('HtmlVideoPlayer: the shared AudioContext is resumed for the next track and closed on destroy()', async () => {
    window.AudioContext = StrictAudioContext;
    StrictAudioContext.instances = [];
    const { player } = createPlayer();

    await playAndStart(player, track(-6));
    await player.stop();
    assert.strictEqual(mediaContexts()[0].state, 'suspended');

    await playAndStart(player, track(-6));
    assert.strictEqual(mediaContexts()[0].state, 'running');

    player.destroy();
    assert.strictEqual(mediaContexts()[0].closed, true);
    delete window.AudioContext;
});

// ----------------------------------------------------------------------------
// HLS start watchdog
// ----------------------------------------------------------------------------

test('HtmlVideoPlayer: a slow transcode start is not reported as a failed resume', () => {
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();
    video.paused = false;
    const resume = { playerStartPositionTicks: 6000000000 };

    // No segment from the transcoder yet: restarting would only start the transcode again
    player._onHlsStartTimeout({ ...resume, playMethod: 'Transcode' }, 600, 0);
    assert.ok(!events.includes('resumeseekfailed'));

    // Segments buffered but no start: stuck decoder → restart at the target
    player._onHlsStartTimeout({ ...resume, playMethod: 'Transcode' }, 600, 2);
    player._onHlsStartTimeout({ ...resume, playMethod: 'Remux' }, 600, 0);
    assert.strictEqual(events.filter((e) => e === 'resumeseekfailed').length, 2);
});

// ----------------------------------------------------------------------------
// Resume start time
// ----------------------------------------------------------------------------

const resumeAt = (seconds) => ({
    url: 'http://srv/Videos/a/stream.mkv',
    mediaSource,
    item: { Type: 'Episode' },
    playerStartPositionTicks: Math.round(seconds * 10000000)
});

test('HtmlVideoPlayer: a resume the media fragment already landed starts without waiting for a seek', async (t) => {
    // webOS applies #t= after 'loadedmetadata'; seeking to the same spot fires no 'seeked'
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { player } = createPlayer();
    const playing = player.play(resumeAt(486.65));
    await flush();
    await flush();
    const video = player._videoElement;
    video.fire('loadedmetadata'); // playhead still at 0
    video.currentTime = 486.65; // fragment lands
    video.fire('canplay');
    await flush();

    let started = false;
    playing.then(() => (started = true));
    await flush();
    assert.ok(started, 'resume waited for a seeked event that never comes');
    assert.strictEqual(video.playCalls, 1);
});

test('HtmlVideoPlayer: a resume seek still pending while paused does not hold playback back', async (t) => {
    // webOS carries out the seek only once playback starts: 'seeked' never comes while paused
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { player } = createPlayer();
    const playing = player.play(resumeAt(486.65));
    await flush();
    await flush();
    const video = player._videoElement;
    video.fire('loadedmetadata');
    video.fire('canplay'); // explicit seek to 486.65 …
    video.seeking = true; // … which the pipeline leaves pending
    let started = false;
    playing.then(() => (started = true));

    t.mock.timers.tick(1000);
    await flush();
    assert.ok(started, 'resume waited the full 10 s failsafe for a seek that needs playback');
    assert.strictEqual(video.playCalls, 1);
    assert.strictEqual(player._resumeVideoSuppressed, true, 'picture shown before the seek landed');

    video.seeking = false;
    video.fire('seeked');
    assert.strictEqual(player._resumeVideoSuppressed, false);
    assert.strictEqual(video.playCalls, 1, 'playback started twice');
});

test('HtmlVideoPlayer: a resume keeps the old frame and sound hidden when playing overtakes the seek', async (t) => {
    // webOS fires 'playing' about a second before the resume seek lands
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { player } = createPlayer();
    const playing = player.play(resumeAt(864.95));
    await flush();
    await flush();
    const video = player._videoElement;
    // The webOS resume mute (set in play() on webOS only)
    video.muted = true;
    player._resumeAudioSuppressed = true;
    const seekedListeners = video.listenerCount('seeked');
    video.fire('loadedmetadata');
    video.fire('canplay');
    video.seeking = true;
    t.mock.timers.tick(1000);
    await playing;

    video.fire('playing');
    assert.strictEqual(player._resumeVideoSuppressed, true, 'pre-seek frame shown before the resume seek landed');
    assert.strictEqual(video.muted, true, 'pre-seek sound played before the resume seek landed');

    video.seeking = false;
    video.fire('seeked');
    assert.strictEqual(player._resumeVideoSuppressed, false);
    assert.strictEqual(video.muted, false);
    assert.strictEqual(video.listenerCount('seeked'), seekedListeners, 'one-shot seeked listener left behind');
});

test('HtmlVideoPlayer: a resume seek overtaken by playing that never lands still shows the picture', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { player } = createPlayer();
    const playing = player.play(resumeAt(864.95));
    await flush();
    await flush();
    const video = player._videoElement;
    video.fire('loadedmetadata');
    video.fire('canplay');
    video.seeking = true;
    t.mock.timers.tick(1000);
    await playing;
    video.fire('playing');
    assert.strictEqual(player._resumeVideoSuppressed, true);

    t.mock.timers.tick(10000);
    assert.strictEqual(player._resumeVideoSuppressed, false, 'picture hidden for good');
});


// ----------------------------------------------------------------------------
// 'stalled' with a full buffer
// ----------------------------------------------------------------------------

function bufferedAhead(video, seconds) {
    video.buffered = { length: 1, start: () => 0, end: () => video.currentTime + seconds };
}

test('HtmlVideoPlayer: a stalled download with a full buffer is neither buffering nor kicked', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { player, events } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource });
    const video = player._videoElement;
    video.fire('playing');
    video.currentTime = 600;
    video.readyState = 4;
    bufferedAhead(video, 45);
    events.length = 0;

    video.fire('stalled');
    assert.ok(!events.includes('waiting'), 'buffering reported (PlayerPage pings the server 3.5 s later)');

    // Playback runs on: no recovery seek
    video.currentTime = 603.5;
    t.mock.timers.tick(3500);
    assert.strictEqual(video.currentTime, 603.5, 'recovery kick seeked a playing video');
});

test('HtmlVideoPlayer: a real stall still gets the recovery kick', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { player, events } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource });
    const video = player._videoElement;
    video.fire('playing');
    video.currentTime = 600;
    video.readyState = 2;
    bufferedAhead(video, 0);
    events.length = 0;

    video.fire('stalled');
    assert.ok(events.includes('waiting'));
    t.mock.timers.tick(3500);
    assert.ok(video.currentTime > 600, 'no recovery kick');
});

test('HtmlVideoPlayer: the stall recovery kick on webOS jumps far enough for its media engine', async (t) => {
    // WebOSPlayer: the webOS engine ignores a 10 ms jump inside the decoded frame
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const platform = platformInfo._platform;
    platformInfo._platform = 'webos';
    t.after(() => (platformInfo._platform = platform));
    const { player } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource });
    const video = player._videoElement;
    video.fire('playing');
    video.currentTime = 600;
    video.readyState = 2;
    bufferedAhead(video, 0);

    video.fire('stalled');
    t.mock.timers.tick(3500);
    assert.strictEqual(video.currentTime, 600.5);
});

test('HtmlVideoPlayer: Play after a seek that never reports seeked still starts playback', async (t) => {
    // webOS carries out a seek on a paused element only once playback starts
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { player } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource });
    const video = player._videoElement;
    const plays = video.playCalls;

    video.seeking = true;
    player.unpause();
    assert.strictEqual(video.playCalls, plays);
    t.mock.timers.tick(500);
    assert.strictEqual(video.playCalls, plays + 1, 'Play queued for a seeked event that never comes');

    player.unpause();
    player.unpause();
    assert.strictEqual(video.playCalls, plays + 2, 'a second Play press waited as well');
});

test('HtmlVideoPlayer: a Pause that cancels a play queued behind a seek reports the pause', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { player, events } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource });
    const video = player._videoElement;
    video.paused = true;
    video.seeking = true;
    player.unpause();
    events.length = 0;

    player.pause();
    assert.deepStrictEqual(events, ['pause']);
    t.mock.timers.tick(1000);
    assert.strictEqual(video.paused, true, 'the cancelled play started anyway');

    events.length = 0;
    player.pause();
    assert.deepStrictEqual(events, [], 'reported a pause with nothing queued');
});

test('HtmlVideoPlayer: switching subtitle tracks and back does not double the cue offset', async () => {
    // Instantiate player and start playback
    const { player } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource });
    const video = player._videoElement;

    // Construct mock text tracks with initial timing cues
    const tracks = [
        {
            mode: 'showing',
            cues: [
                { startTime: 10, endTime: 12, text: 'cue 1' },
                { startTime: 20, endTime: 22, text: 'cue 2' }
            ]
        },
        {
            mode: 'showing',
            cues: [
                { startTime: 10, endTime: 12, text: 'cue un' }
            ]
        }
    ];
    video.textTracks = tracks;

    // Select track 0 and shift its cue timestamps by +2 seconds
    player.setSubtitleStreamIndex(0);
    player.setSubtitleOffset(2);
    assert.strictEqual(tracks[0].cues[0].startTime, 12, 'offset applied to track 0');

    // Switch active stream to track 1, then switch back to track 0
    player.setSubtitleStreamIndex(1);
    player.setSubtitleStreamIndex(0);

    // Track switch resets the stream offset to 0; cues must return to original baseline
    assert.strictEqual(tracks[0].cues[0].startTime, 10, 'switching back must reset cues to baseline 0 offset');

    // Re-applying +2s offset must compute delta against baseline and not double the offset
    player.setSubtitleOffset(2);
    assert.strictEqual(tracks[0].cues[0].startTime, 12, 're-applying offset must not double to 14');
    assert.strictEqual(tracks[0].cues[0].endTime, 14);

    await player.stop();
});

test('HtmlVideoPlayer: native subtitle tracks are disabled when unselected, not left loading', async () => {
    // Instantiate player and initialize media session
    const { player } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource });
    const video = player._videoElement;

    // Attach mock text tracks initially set to showing
    const tracks = [
        { mode: 'showing', cues: [] },
        { mode: 'showing', cues: [] }
    ];
    video.textTracks = tracks;

    // Disabling all native tracks (e.g. SubtitleManager taking over rendering or subtitle turned off)
    player.setSubtitleStreamIndex(-1);
    assert.deepStrictEqual(
        tracks.map((t) => t.mode),
        ['disabled', 'disabled'],
        'all tracks must be disabled to halt background fetching and parsing'
    );

    // Activating track 1 must set track 1 to showing and track 0 to disabled
    player.setSubtitleStreamIndex(1);
    assert.deepStrictEqual(
        tracks.map((t) => t.mode),
        ['disabled', 'showing'],
        'selected track must be showing while unselected track remains disabled'
    );

    await player.stop();
});


