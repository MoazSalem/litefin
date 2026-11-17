import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: Dolby Vision codec hint on webOS 24
 * ============================================================================
 * LG's Chromium answers '' for canPlayType('video/mp4; codecs="dvh1"') even on
 * Dolby Vision-capable sets (LG C2 / webOS 24). The hinted <source> path must
 * still be used on a real webOS runtime, with the existing <source> 'error'
 * handler retrying a raw src on sets that reject the hint. Dev browsers keep
 * the canPlayType guard.
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

/** Every canPlayType() answer: '' reproduces a webOS 24 C2. */
let canPlayAnswer = () => '';
let dvh1Probes = 0;

function createVideo() {
    return createEventTarget({
        tagName: 'VIDEO',
        children: [],
        style: {},
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
            this.paused = false;
            return Promise.resolve();
        },
        canPlayType: (type) => {
            if (type.includes('dvh1')) dvh1Probes++;
            return canPlayAnswer(type);
        }
    });
}

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = createEventTarget({
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement(tag) {
        if (tag === 'video') return createVideo();
        if (tag === 'source') return createEventTarget({ tagName: 'SOURCE', src: '', type: '' });
        return {
            classList: { add() {}, remove() {}, toggle() {} },
            style: {},
            addEventListener() {},
            appendChild() {}
        };
    }
});
globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U\n' });

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');
const { platformInfo } = await import('../src/utils/PlatformInfo.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const originalPlatform = platformInfo._platform;
const url = 'http://srv/Videos/dv/stream.mkv';
const doviMediaSource = {
    Container: 'mkv',
    MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'hevc', VideoRangeType: 'DOVIWithHDR10' }]
};

function createPlayer() {
    const container = { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} };
    return new WebOSPlayer({ container, onEvent() {} });
}

test('webOS 24: dvh1 hint is used even when canPlayType("dvh1") returns ""', async () => {
    canPlayAnswer = () => '';
    dvh1Probes = 0;
    platformInfo._platform = 'webos';
    try {
        const player = createPlayer();
        const playing = player.play({ url, playMethod: 'DirectPlay', mediaSource: doviMediaSource });
        await flush();

        const video = player._videoElement;
        const source = video.firstChild;
        assert.strictEqual(source?.tagName, 'SOURCE', 'the Dolby Vision hint path was not taken');
        assert.strictEqual(source.type, 'video/mp4; codecs="dvh1"');
        assert.strictEqual(video.src, '', 'raw src must not be set while the hinted source is active');
        assert.strictEqual(dvh1Probes, 0, 'the unreliable dvh1 probe must not gate the hint on webOS');

        video.fire('canplay');
        await playing;
    } finally {
        platformInfo._platform = originalPlatform;
        canPlayAnswer = () => '';
    }
});

test('webOS 24: a TV rejecting the hint still retries with raw src', async () => {
    canPlayAnswer = () => '';
    platformInfo._platform = 'webos';
    try {
        const player = createPlayer();
        const playing = player.play({ url, playMethod: 'DirectPlay', mediaSource: doviMediaSource });
        await flush();

        const video = player._videoElement;
        video.firstChild.fire('error');
        assert.strictEqual(video.src, url, 'a rejected dvh1 hint must retry with raw src');
        assert.strictEqual(video.firstChild, null, 'the rejected hinted source must be removed');

        video.fire('canplay');
        await playing;
    } finally {
        platformInfo._platform = originalPlatform;
        canPlayAnswer = () => '';
    }
});

test('dev browsers keep the canPlayType guard and fall back to raw src', async () => {
    canPlayAnswer = () => '';
    platformInfo._platform = 'web';
    try {
        const player = createPlayer();
        const playing = player.play({ url, playMethod: 'DirectPlay', mediaSource: doviMediaSource });
        await flush();

        const video = player._videoElement;
        assert.strictEqual(video.firstChild, null, 'a dev browser must not use the hint when the probe rejects it');
        assert.strictEqual(video.src, url, 'expected raw src fallback in a dev browser');

        video.fire('canplay');
        await playing;
    } finally {
        platformInfo._platform = originalPlatform;
        canPlayAnswer = () => '';
    }
});
