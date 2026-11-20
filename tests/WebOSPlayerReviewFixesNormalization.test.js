import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: audio normalization is in place before a track loads
 * ============================================================================
 * stop() replaces a <video> routed into Web Audio, so every queued track
 * starts on a fresh element. Set up after play() resolved, the gain came in
 * only once the track was already playing at full level.
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

function createVideo() {
    return createEventTarget({
        children: [],
        style: {},
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 240,
        muted: false,
        paused: true,
        seeking: false,
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
            child.parentNode = null;
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

/** Web Audio stand-in that records what the element was doing when it was connected */
class RecordingAudioContext {
    constructor() {
        this.state = 'running';
        this.destination = {};
        this.connected = [];
    }
    createMediaElementSource(element) {
        if (element.webAudioSource) throw new Error('InvalidStateError: element already connected');
        element.webAudioSource = true;
        this.connected.push({ element, src: element.src, playCalls: element.playCalls });
        return { connect() {}, disconnect() {} };
    }
    createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
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
window.AudioContext = RecordingAudioContext;

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

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
    return new WebOSPlayer({ container, onEvent: () => {} });
}

const track = (gainDb) => ({
    url: 'http://srv/Audio/1/stream.mp3',
    item: { MediaType: 'Audio', NormalizationGain: gainDb },
    mediaSource: {}
});
const movie = {
    url: 'http://srv/Videos/m/stream.mkv',
    item: { Type: 'Movie', MediaType: 'Video' },
    mediaSource: { MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264' }] }
};

/** play() up to the point where the load waits for 'canplay' */
async function startLoading(player, options) {
    const playing = player.play(options);
    await flush();
    return { playing };
}

test('WebOSPlayer: every queued track has its normalization gain before it loads', async () => {
    const player = createPlayer();

    for (const [gainDb, linear] of [
        [-6, 0.501],
        [-12, 0.251]
    ]) {
        const { playing } = await startLoading(player, track(gainDb));
        const video = player._videoElement;
        const graph = player._audioGraph;
        assert.ok(graph && graph.element === video, 'the track loads without its gain');
        assert.ok(Math.abs(graph.gain.gain.value - linear) < 0.001);
        const connection = graph.context.connected.at(-1);
        assert.strictEqual(connection.element, video);
        assert.strictEqual(connection.src, '', 'connected after the load had started');
        assert.strictEqual(connection.playCalls, 0);

        video.fire('canplay');
        await playing;
        await player.stop(); // releases the element with its graph: the next track gets a fresh one
    }
});

test('WebOSPlayer: a movie after a normalized track on the same element loads at unity gain', async () => {
    const player = createPlayer();
    const { playing: first } = await startLoading(player, track(-6));
    player._videoElement.fire('canplay');
    await first;

    // No stop() in between: the element stays routed through the graph
    const { playing } = await startLoading(player, movie);
    assert.strictEqual(player._audioGraph.gain.gain.value, 1, 'the movie loads at the track gain');
    assert.strictEqual(player._videoElement.playCalls, 1);

    player._videoElement.fire('canplay');
    await playing;
    await player.stop();
});
