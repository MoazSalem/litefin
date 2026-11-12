import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

/**
 * ============================================================================
 * Tizen Smoothness, Splash Cleanup & Finish Long-Task Regression Suite
 * ============================================================================
 * Verifies Part 2 & Part 3 fixes across:
 *   1. Splash overlay + spinner keyframe teardown in index.html,
 *      index.ultra-legacy.html, base.css, and App.js.
 *   2. TizenAdapter.warmupCompositor() platform isolation, read-only AVPlay
 *      probe, 2-rAF probe node cleanup, and idempotency.
 *   3. HeroCarousel decode()-before-onload guarantee, neighbor prewarm after
 *      decode completion, deferred scroll:finished auto-scroll startup, and
 *      hero-carousel.css dot-width transition removal + prewarm content rule.
 *   4. LazyLoader post-scroll cooldown / _shimmerObserver deferral and
 *      ScrollController deferred finish emission + single Frame-K finalize.
 * ============================================================================
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readSrc = (relPath) => readFileSync(resolve(__dirname, '..', relPath), 'utf8');

// ============================================================================
// Minimal Shared Browser Environment Stubs (for live behavioral module tests)
// ============================================================================

const storageMap = new Map();
globalThis.localStorage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear(),
    key: (i) => Array.from(storageMap.keys())[i] ?? null,
    get length() {
        return storageMap.size;
    }
};
globalThis.sessionStorage = globalThis.localStorage;

if (!globalThis.navigator) {
    globalThis.navigator = { userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 9.0)' };
}

const rafQueue = [];
let rafSeq = 1;
const scheduleRaf = (cb) => {
    const id = rafSeq++;
    rafQueue.push({ id, cb });
    return id;
};
const cancelRaf = (id) => {
    const idx = rafQueue.findIndex((r) => r.id === id);
    if (idx !== -1) rafQueue.splice(idx, 1);
};
const flushOneRaf = () => {
    const batch = rafQueue.splice(0, rafQueue.length);
    for (const entry of batch) {
        entry.cb(performance.now());
    }
    return batch.length;
};

globalThis.requestAnimationFrame = scheduleRaf;
globalThis.cancelAnimationFrame = cancelRaf;

const appendedBodyNodes = [];
const ioInstances = [];
const windowListeners = new Map();

function createMockElement(tagName = 'div', classes = [], dataset = {}) {
    const cls = new Set(classes);
    const attrs = new Map();
    const el = {
        tagName: tagName.toUpperCase(),
        type: '',
        isConnected: true,
        dataset: { ...dataset },
        style: {},
        naturalWidth: 0,
        naturalHeight: 0,
        complete: false,
        _src: '',
        onload: null,
        onerror: null,
        parentNode: null,
        _closestContainer: null,
        _children: [],
        childrenBySelector: new Map(),
        childrenAllBySelector: new Map(),
        classList: {
            add: (...names) => names.forEach((n) => cls.add(n)),
            remove: (...names) => names.forEach((n) => cls.delete(n)),
            contains: (n) => cls.has(n)
        },
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => (k === 'src' ? el._src || null : attrs.get(k) ?? null),
        hasAttribute: (k) => attrs.has(k),
        removeAttribute: (k) => attrs.delete(k),
        addEventListener: () => {},
        removeEventListener: () => {},
        closest: () => el._closestContainer,
        querySelector: (sel) => el.childrenBySelector.get(sel) || null,
        querySelectorAll: (sel) => el.childrenAllBySelector.get(sel) || [],
        appendChild: (child) => {
            child.parentNode = el;
            el._children.push(child);
            appendedBodyNodes.push(child);
            return child;
        },
        removeChild: (child) => {
            const idx = el._children.indexOf(child);
            if (idx !== -1) el._children.splice(idx, 1);
            child.parentNode = null;
            return child;
        },
        contains: (target) => el._children.includes(target) || el._contained?.includes(target) || false,
        get src() {
            return el._src;
        },
        set src(val) {
            el._src = val;
        }
    };
    return el;
}

const mockDocEl = createMockElement('html');
mockDocEl.dir = 'ltr';
mockDocEl.style = { transform: '' };

const mockBody = createMockElement('body');

globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    location: { hash: '#/home' },
    __scrollController: { isAnimating: false },
    requestAnimationFrame: scheduleRaf,
    cancelAnimationFrame: cancelRaf,
    addEventListener: (type, fn) => {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
    },
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
    IntersectionObserver: class MockIO {
        constructor(cb, options = {}) {
            this.cb = cb;
            this.options = options;
            ioInstances.push(this);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
    }
};
globalThis.IntersectionObserver = globalThis.window.IntersectionObserver;

globalThis.document = {
    documentElement: mockDocEl,
    body: mockBody,
    createElement: (tag) => createMockElement(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => true
};

// Controllable Image mock allowing tests to fire onload before decode() resolves
let nextImageFactory = null;
globalThis.Image = class ControllableImage {
    constructor() {
        this._src = '';
        this.onload = null;
        this.onerror = null;
        this.complete = false;
        this.naturalWidth = 0;
        if (nextImageFactory) {
            nextImageFactory(this);
        }
    }
    set src(val) {
        this._src = val;
    }
    get src() {
        return this._src;
    }
    decode() {
        return Promise.resolve();
    }
};

const { eventBus } = await import('../src/core/EventBus.js');
const { default: TizenAdapter, tizenAdapter } = await import('../src/tizen/TizenAdapter.js');
const { TizenAVPlayer } = await import('../src/player/core/TizenAVPlayer.js');
const { default: HeroCarousel } = await import('../src/ui/HeroCarousel.js');
const { lazyLoader } = await import('../src/utils/LazyLoader.js');
const { default: ScrollController } = await import('../src/ui/ScrollController.js');

// ============================================================================
// 1. Part 2 — Splash Spinner & App Teardown Verification
// ============================================================================

test('Splash & spinners: index HTML, base CSS, and App.js tear down infinite splash layers on dismissal', () => {
    const indexHtml = readSrc('src/index.html');
    const ultraHtml = readSrc('src/index.ultra-legacy.html');
    const baseCss = readSrc('src/styles/base.css');
    const appJs = readSrc('src/core/App.js');

    for (const [label, html] of [
        ['index.html', indexHtml],
        ['index.ultra-legacy.html', ultraHtml]
    ]) {
        assert.match(
            html,
            /#app-splash\.splash-content\.fade-out \*,\s*#app-splash\.splash-content\.fade-out \*::before,\s*#app-splash\.splash-content\.fade-out \*::after[\s\S]*animation:\s*none\s*!important;[\s\S]*will-change:\s*auto\s*!important;/,
            `${label} must shut down splash spinner animations and will-change immediately on fade-out`
        );
    }

    assert.match(
        baseCss,
        /body\.app-splash-active \.page-loading \.loading-spinner[\s\S]*animation-play-state:\s*paused\s*!important;/,
        'base.css must pause hidden page-loading spinner keyframes while app-splash-active is present'
    );
    assert.match(
        baseCss,
        /#app-splash\.splash-content\.fade-out \*[\s\S]*animation:\s*none\s*!important;/,
        'base.css must override theme-specific splash spinner animations during fade-out'
    );

    const hideSplashStart = appJs.indexOf('const splash = document.getElementById(\'app-splash\');');
    assert.notEqual(hideSplashStart, -1, 'App.js must look up #app-splash');
    const hideSplashSlice = appJs.slice(hideSplashStart, hideSplashStart + 1400);
    assert.ok(hideSplashSlice.includes('transitionend'), 'App.js must clean up splash cleanly on opacity transitionend');
    assert.ok(
        hideSplashSlice.includes("splash.style.willChange = 'auto'") &&
            hideSplashSlice.includes("splash.style.transform = 'none'"),
        'App.js must clear compositor promotion inline properties before detaching #app-splash'
    );
});

// ============================================================================
// 2. Part 2 — TizenAdapter Native AVPlay Hardware Warmup & Abort Behavior
// ============================================================================

test('TizenAdapter.warmupCompositor: real native AVPlayManager prepareAsync/play/close cycle, wgt-package path resolution, abort & TizenAVPlayer coordination', async () => {
    rafQueue.length = 0;
    mockBody._children.length = 0;

    /*
     * Verify the packaged warmup clip is a valid, short, standard MP4 with both
     * H.264 video and AAC audio. A 1-frame / 40ms video-only clip can leave the
     * native decoder in READY without ever presenting a frame.
     */
    const warmupAssetPath = resolve(__dirname, '..', 'src', 'assets', 'warmup.mp4');
    const warmupBuffer = readFileSync(warmupAssetPath);
    const warmupStat = statSync(warmupAssetPath);
    const warmupAscii = warmupBuffer.toString('latin1');
    assert.ok(warmupStat.size > 200 && warmupStat.size < 16384, 'src/assets/warmup.mp4 must be a compact valid MP4');
    assert.ok(warmupAscii.includes('ftyp'), 'warmup.mp4 must be a valid ISO-BMFF MP4 container');
    assert.ok(warmupAscii.includes('avc1'), 'warmup.mp4 must contain an H.264 (avc1) video track');
    assert.ok(warmupAscii.includes('mp4a'), 'warmup.mp4 must contain an AAC (mp4a) audio track');
    assert.ok(
        warmupAscii.includes('moov') && warmupAscii.includes('mdat'),
        'warmup.mp4 must contain moov + mdat boxes for AVPlay demuxing'
    );
    assert.match(
        readSrc('webpack.config.cjs'),
        /from:\s*'src\/assets'\s*,\s*to:\s*'assets'/,
        'webpack CopyWebpackPlugin must copy src/assets into assets/'
    );

    const origGetById = globalThis.document.getElementById;
    const origCreateEl = globalThis.document.createElement;
    const origAudioCtx = globalThis.window.AudioContext;
    const origLocation = globalThis.window.location;
    let audioConstructed = 0;
    let audioResumed = 0;
    let audioClosed = 0;

    globalThis.document.getElementById = (id) => mockBody._children.find((node) => node.id === id) || null;
    globalThis.document.createElement = (tag) => origCreateEl(tag);
    globalThis.window.AudioContext = class MockAudioContext {
        constructor() {
            audioConstructed++;
            this.state = 'suspended';
        }
        resume() {
            audioResumed++;
            this.state = 'running';
            return Promise.resolve();
        }
        close() {
            audioClosed++;
            this.state = 'closed';
            return Promise.resolve();
        }
    };

    try {
        let stateReads = 0;
        let currentState = 'NONE';
        const callOrder = [];
        const openedUrls = [];
        const displayRects = [];
        const pendingPrepareCbs = [];
        const fsResolveCalls = [];
        let playCalls = 0;
        let listenerResets = 0;
        let stopCalls = 0;
        let closeCalls = 0;

        globalThis.window.location = {
            protocol: 'file:',
            href: 'file:///opt/usr/apps/litefin/res/wgt/index.html#/home',
            hash: '#/home'
        };

        // Tizen wgt-package virtual root: dir.path is the absolute Linux folder
        // AVPlay needs; toURI() yields the file:// form.
        globalThis.tizen = {
            filesystem: {
                resolve: (location, onSuccess, onError, mode) => {
                    fsResolveCalls.push({ location, mode });
                    onSuccess({
                        path: '/opt/usr/apps/litefin/res/wgt',
                        toURI: () => 'file:///opt/usr/apps/litefin/res/wgt'
                    });
                },
                toURI: (path) => 'file://' + String(path).replace('wgt-package', '/opt/usr/apps/litefin/res/wgt')
            }
        };

        globalThis.window.webapis = {
            avplay: {
                getState: () => {
                    stateReads++;
                    return currentState;
                },
                open: (url) => {
                    callOrder.push('open');
                    openedUrls.push(url);
                },
                setDisplayRect: (...rect) => {
                    callOrder.push('setDisplayRect');
                    displayRects.push(rect);
                },
                prepareAsync: (onPrepared, onError) => {
                    callOrder.push('prepareAsync');
                    pendingPrepareCbs.push({ onPrepared, onError });
                },
                play: () => {
                    callOrder.push('play');
                    playCalls++;
                },
                setListener: (val) => {
                    callOrder.push('setListener');
                    if (val === null) listenerResets++;
                },
                stop: () => {
                    callOrder.push('stop');
                    stopCalls++;
                },
                close: () => {
                    callOrder.push('close');
                    closeCalls++;
                }
            }
        };

        // 1. Non-Tizen guard: must never touch AVPlay, AudioContext, or mount warmup nodes
        const nonTizen = new TizenAdapter();
        nonTizen._isTizen = false;
        assert.equal(nonTizen.warmupCompositor(), false);
        assert.equal(stateReads, 0, 'Non-Tizen target must never call webapis.avplay');
        assert.equal(audioConstructed, 0, 'Non-Tizen target must not touch AudioContext');
        assert.equal(mockBody._children.length, 0, 'Non-Tizen target must not mount warmup nodes');

        // 2. Tizen path: absolute wgt-package path -> 1920x1080 prepareAsync -> play -> 200ms -> stop+close
        const tvAdapter = new TizenAdapter();
        tvAdapter._isTizen = true;
        assert.equal(tvAdapter.warmupCompositor(), true);
        assert.equal(tvAdapter.isWarmupActive(), true);
        assert.equal(audioConstructed, 1);
        assert.equal(audioResumed, 1);
        assert.deepEqual(fsResolveCalls, [{ location: 'wgt-package', mode: 'r' }]);
        assert.deepEqual(openedUrls, ['/opt/usr/apps/litefin/res/wgt/assets/warmup.mp4']);
        assert.deepEqual(displayRects, [[0, 0, 1920, 1080]]);
        assert.equal(pendingPrepareCbs.length, 1);

        const probe = mockBody._children.find((el) => el.id === 'litefin-avplay-warmup');
        assert.ok(probe && probe.type === 'application/avplayer', 'AVPlayer <object> must mount');
        assert.equal(probe.style.width, '1920px', 'AVPlayer <object> must be sized 1920x1080');
        assert.equal(probe.style.height, '1080px');
        assert.equal(probe.style.pointerEvents, 'none');
        assert.equal(probe.style.opacity, '1');

        const warmupVideo = mockBody._children.find((el) => el.id === 'litefin-html5-warmup');
        assert.ok(warmupVideo, 'Full-screen HTML5 <video> warmup layer must mount behind the splash');
        assert.ok(
            String(warmupVideo.src).endsWith('assets/warmup.mp4'),
            'HTML5 <video> must use the WebView-relative assets/warmup.mp4 URL'
        );
        assert.equal(warmupVideo.style.width, '1920px');
        assert.equal(warmupVideo.style.height, '1080px');
        assert.equal(warmupVideo.muted, true);
        assert.equal(mockDocEl.classList.contains('player-active'), true, 'html must get player-active during warmup');
        assert.equal(mockBody.classList.contains('player-active'), true, 'body must get player-active during warmup');

        // Invalid raw path: firmware rejects it, adapter must retry with the file:// URI form
        pendingPrepareCbs.shift().onError(new Error('PLAYER_ERROR_INVALID_URI'));
        assert.deepEqual(
            openedUrls,
            ['/opt/usr/apps/litefin/res/wgt/assets/warmup.mp4', 'file:///opt/usr/apps/litefin/res/wgt/assets/warmup.mp4'],
            'Adapter must fall back from the raw Linux path to the file:// URI on prepare errors'
        );
        assert.equal(pendingPrepareCbs.length, 1);

        // Second candidate succeeds: prepareAsync -> play -> hold -> stop+close
        pendingPrepareCbs.shift().onPrepared();
        assert.equal(playCalls, 1, 'onPrepared must start avplay.play()');
        await new Promise((resolve) => setTimeout(resolve, 240));
        assert.equal(listenerResets, 1);
        assert.equal(stopCalls, 2, 'One stop for the rejected candidate, one on final teardown');
        assert.equal(closeCalls, 2, 'One close for the rejected candidate, one on final teardown');
        assert.equal(tvAdapter.isWarmupActive(), false);
        assert.deepEqual(callOrder, [
            'open',
            'setDisplayRect',
            'prepareAsync',
            'stop',
            'close',
            'open',
            'setDisplayRect',
            'prepareAsync',
            'play',
            'setListener',
            'stop',
            'close'
        ]);
        assert.equal(
            mockBody._children.includes(probe),
            false,
            'Warmup AVPlayer <object> must be removed entirely on teardown (TizenAVPlayer owns the playback host)'
        );
        assert.equal(
            mockBody._children.includes(warmupVideo),
            false,
            'Full-screen HTML5 <video> warmup layer must be removed'
        );
        assert.equal(mockDocEl.classList.contains('player-active'), false, 'player-active must be cleared on html');
        assert.equal(mockBody.classList.contains('player-active'), false, 'player-active must be cleared on body');
        assert.equal(audioClosed, 1);

        // 3. Idempotency guard: second call must not reopen AVPlay or duplicate DOM probe
        assert.equal(tvAdapter.warmupCompositor(), true);
        assert.equal(openedUrls.length, 2);
        assert.equal(mockBody._children.length, 0, 'Warmup must leave no dormant DOM node behind');

        // 3b. TizenAVPlayer owns the playback <object> and releases it again
        const hostPlayer = new TizenAVPlayer({});
        hostPlayer._avplay = globalThis.window.webapis.avplay;
        const host = hostPlayer._ensureAvPlayerObject();
        assert.ok(host && host.type === 'application/avplayer', 'TizenAVPlayer must mount its own AVPlayer host');
        assert.equal(host.id, 'litefin-avplayer-host');
        assert.equal(mockBody._children.includes(host), true);
        assert.equal(host.style.position, 'fixed');
        assert.equal(host.style.width, '100%', 'Playback host must span the viewport for setDisplayRect() planes');
        assert.equal(host.style.height, '100%');
        assert.equal(host.style.pointerEvents, 'none', 'Playback host must not swallow OSD input');
        assert.equal(hostPlayer._ensureAvPlayerObject(), host, 'Host mount must be idempotent');
        assert.equal(mockBody._children.length, 1, 'Host mount must never duplicate the <object>');

        hostPlayer._removeAvPlayerObject();
        assert.equal(mockBody._children.includes(host), false, 'TizenAVPlayer must remove its host on teardown');
        assert.equal(mockBody._children.length, 0);

        const tizenPlayerSrc = readSrc('src/player/core/TizenAVPlayer.js');
        assert.match(
            tizenPlayerSrc,
            /this\._ensureAvPlayerObject\(\);\s*this\._avplay\.open\(/,
            'TizenAVPlayer.play() must mount the plane host before avplay.open()'
        );
        assert.ok(
            tizenPlayerSrc.includes('this._removeAvPlayerObject();'),
            'TizenAVPlayer must release the plane host on stop()/destroy()'
        );

        // 4. Active playback guard: must skip warmup when AVPlay state is already PLAYING
        currentState = 'PLAYING';
        const busyAdapter = new TizenAdapter();
        busyAdapter._isTizen = true;
        assert.equal(busyAdapter.warmupCompositor(), true);
        assert.equal(openedUrls.length, 2, 'Must skip avplay.open when real session is PLAYING');
        assert.equal(busyAdapter.isWarmupActive(), false);

        // 5. abortWarmup() cancels pending prepareAsync AND ignores stale late callbacks
        currentState = 'NONE';
        const abortAdapter = new TizenAdapter();
        abortAdapter._isTizen = true;
        abortAdapter.warmupCompositor();
        assert.equal(abortAdapter.isWarmupActive(), true);
        assert.equal(openedUrls.length, 3);
        assert.equal(abortAdapter.abortWarmup(), true);
        assert.equal(abortAdapter.isWarmupActive(), false);
        const stopCountAfterAbort = stopCalls;
        const closeCountAfterAbort = closeCalls;

        // Simulate stale native callback arriving AFTER abortWarmup() already released warmup
        pendingPrepareCbs.shift().onPrepared();
        assert.equal(playCalls, 1, 'Stale onPrepared callback after abort must not call avplay.play()');
        assert.equal(stopCalls, stopCountAfterAbort, 'Stale callback must not stop a newer session');
        assert.equal(closeCalls, closeCountAfterAbort, 'Stale callback must not close a newer session');

        // 6. TizenAVPlayer.play() aborts singleton tizenAdapter warmup before starting real playback
        tizenAdapter._isTizen = true;
        tizenAdapter._compositorWarmed = false;
        tizenAdapter.warmupCompositor();
        assert.equal(tizenAdapter.isWarmupActive(), true);

        const fakePlayer = new TizenAVPlayer({});
        fakePlayer._avplay = globalThis.window.webapis.avplay;
        fakePlayer._stopInternal = async () => {
            throw new Error('SENTINEL_AFTER_WARMUP_ABORT');
        };
        await assert.rejects(() => fakePlayer.play({ url: 'http://test/video.mp4' }), /SENTINEL_AFTER_WARMUP_ABORT/);
        assert.equal(
            tizenAdapter.isWarmupActive(),
            false,
            'TizenAVPlayer.play() must abort active warmup before opening real stream'
        );

        // 7. Legacy firmware without prepareAsync falls back cleanly to getState() probe
        const prevPrepare = globalThis.window.webapis.avplay.prepareAsync;
        delete globalThis.window.webapis.avplay.prepareAsync;
        const readsBeforeFallback = stateReads;
        const legacyAdapter = new TizenAdapter();
        legacyAdapter._isTizen = true;
        assert.equal(legacyAdapter.warmupCompositor(), true);
        assert.equal(stateReads, readsBeforeFallback + 1);
        globalThis.window.webapis.avplay.prepareAsync = prevPrepare;

        // 8. Preference gate: Settings > Performance > AVPlay Boot Warmup = off
        //    must skip the native cycle entirely (default is enabled).
        const { storage } = await import('../src/utils/StorageService.js');
        storage.setItem('pref:avplayBootWarmup', 'false');
        const disabledAdapter = new TizenAdapter();
        disabledAdapter._isTizen = true;
        const opensBeforeDisabled = openedUrls.length;
        const readsBeforeDisabled = stateReads;
        assert.equal(disabledAdapter.warmupCompositor(), false, 'Disabled preference must skip warmup');
        assert.equal(disabledAdapter.isWarmupActive(), false);
        assert.equal(openedUrls.length, opensBeforeDisabled, 'Disabled warmup must never call avplay.open');
        assert.equal(stateReads, readsBeforeDisabled, 'Disabled warmup must not touch AVPlay at all');
        assert.equal(mockBody._children.length, 0, 'Disabled warmup must not mount any warmup layers');
        storage.removeItem('pref:avplayBootWarmup');
        const reenabledAdapter = new TizenAdapter();
        reenabledAdapter._isTizen = true;
        assert.equal(
            reenabledAdapter.warmupCompositor(),
            true,
            'Warmup must stay enabled by default when the preference is unset'
        );
        reenabledAdapter.abortWarmup();
    } finally {
        tizenAdapter.abortWarmup();
        tizenAdapter._compositorWarmed = false;
        tizenAdapter._isTizen = false;
        mockBody._children.length = 0;
        delete globalThis.window.webapis;
        delete globalThis.tizen;
        globalThis.window.location = origLocation;
        if (origAudioCtx === undefined) {
            delete globalThis.window.AudioContext;
        } else {
            globalThis.window.AudioContext = origAudioCtx;
        }
        globalThis.document.getElementById = origGetById;
        globalThis.document.createElement = origCreateEl;
    }
});

// ============================================================================
// 2b. Performance Tab — AVPlay Boot Warmup Opt-Out
// ============================================================================

test('Performance settings: AVPlay boot warmup toggle is the first row, Tizen-only, and enabled by default', () => {
    const src = readSrc('src/pages/settings/tabs/PerformanceTab.js');

    assert.match(
        src,
        /const avplayBootWarmupSetting = platformInfo\.isTizen\s*\?/,
        'Warmup row must be rendered only when platformInfo.isTizen is true'
    );
    assert.match(
        src,
        /storage\.getItem\('pref:avplayBootWarmup'\) !== 'false'/,
        'Warmup must default to enabled (only an explicit false disables it)'
    );
    assert.match(src, /id="toggle-avplay-boot-warmup"/, 'Performance tab must own the warmup toggle');
    assert.match(
        src,
        /tizenAdapter\.abortWarmup\(\)/,
        'Disabling the warmup must release any in-flight native AVPlay session'
    );

    // Placement: the warmup row is injected before every other setting row.
    const warmupSlot = src.search(/\$\{avplayBootWarmupSetting\}/);
    const firstLegacyRow = src.indexOf('id="toggle-reload-on-resume"');
    assert.notEqual(warmupSlot, -1, 'Render must interpolate the warmup row');
    assert.ok(warmupSlot < firstLegacyRow, 'AVPlay boot warmup must be the first setting in the Performance tab');

    // Non-Tizen targets must not ship the row at all.
    assert.match(
        src,
        /platformInfo\.isTizen\s*\?\s*`[\s\S]*?:\s*'';/,
        'Non-Tizen branch must render an empty string instead of the warmup row'
    );
});

// ============================================================================
// 3. Part 3 Cluster 1 — HeroCarousel CSS, Decode Ordering & Deferred AutoStart
// ============================================================================

test('HeroCarousel CSS: pins compositor layer, removes .hero-item--prewarm bloat, and isolates logo container', () => {
    const css = readSrc('src/styles/hero-carousel.css');
    const dotRuleMatch = css.match(/^\.hero-dot\s*\{([^}]+)\}/m);
    assert.ok(dotRuleMatch, '.hero-dot rule must exist');
    assert.ok(
        !/transition:[^;]*\bwidth\b/.test(dotRuleMatch[1]),
        '.hero-dot must not animate width (forces flex layout thrash across indicators after goTo)'
    );

    const carouselRule = css.match(/^\.hero-carousel\s*\{([^}]+)\}/m);
    assert.ok(carouselRule, '.hero-carousel rule must exist');
    assert.ok(
        carouselRule[1].includes('will-change: transform;') &&
            carouselRule[1].includes('backface-visibility: hidden;') &&
            carouselRule[1].includes('contain: layout style paint;'),
        '.hero-carousel must pin its compositor layer and layout/paint containment'
    );

    const logoContainerRule = css.match(/^\.hero-logo-container\s*\{([^}]+)\}/m);
    assert.ok(logoContainerRule && logoContainerRule[1].includes('contain: layout style;'), '.hero-logo-container must contain layout/style');

    const backdropImgRule = css.match(/^\.hero-backdrop-img\s*\{([^}]+)\}/m);
    assert.ok(backdropImgRule && backdropImgRule[1].includes('object-fit: cover;'), '.hero-backdrop-img rule must exist');
    assert.ok(!css.includes('.hero-item--prewarm'), '.hero-item--prewarm rule must be removed');
});

test('HeroCarousel: _preloadSlide awaits decode() off-DOM before marking slide ready and swaps on goTo()', async () => {
    rafQueue.length = 0;
    storageMap.clear();
    storageMap.set('pref:heroCarouselStyle', 'immersive-performance');
    storageMap.set('pref:heroCarouselIndicatorStyle', 'dots');
    const mockSc = { isAnimating: false };
    const prevSc = globalThis.window.__scrollController;
    globalThis.window.__scrollController = mockSc;

    let resolveBackdropDecode;
    let resolveLogoDecode;
    let backdropImgInstance = null;

    nextImageFactory = (instance) => {
        backdropImgInstance = instance;
        instance.decode = () =>
            new Promise((resolve) => {
                resolveBackdropDecode = () => {
                    instance.complete = true;
                    instance.naturalWidth = 1280;
                    resolve();
                };
            });
    };

    const items = [0, 1].map((i) => ({ Id: `m-${i}`, Name: `Movie ${i}` }));
    const carousel = new HeroCarousel({ items });

    const container = createMockElement('div', ['hero-carousel-container']);
    container.parentElement = createMockElement('div', ['hero-placeholder']);
    const slide0 = createMockElement('div', ['hero-item', 'active']);
    const slide1 = createMockElement('div', ['hero-item']);
    const backdrop0 = createMockElement('div', ['hero-backdrop'], { backdrop: 'http://test/b0.jpg' });
    const backdrop1 = createMockElement('div', ['hero-backdrop'], { backdrop: 'http://test/b1.jpg' });
    const canvas1 = createMockElement('canvas', ['hero-blurhash-canvas']);
    canvas1.style.opacity = '1';

    for (const b of [backdrop0, backdrop1]) {
        b.children = [];
        Object.defineProperty(b, 'firstChild', { get: () => b.children[0] || null });
        b.appendChild = (c) => {
            if (!b.children.includes(c)) b.children.push(c);
            c.parentNode = b;
            return c;
        };
        b.insertBefore = (c, ref) => {
            const idx = ref ? b.children.indexOf(ref) : -1;
            if (idx === -1) b.children.push(c);
            else b.children.splice(idx, 0, c);
            c.parentNode = b;
            return c;
        };
        b.removeChild = (c) => {
            const idx = b.children.indexOf(c);
            if (idx !== -1) b.children.splice(idx, 1);
            c.parentNode = null;
            return c;
        };
    }

    const logoContainer1 = createMockElement('div', ['hero-logo-container']);
    const logo1 = createMockElement('img', ['hero-logo'], { src: 'http://test/l1.png' });
    logo1._closestContainer = logoContainer1;
    logo1.decode = () =>
        new Promise((resolve) => {
            resolveLogoDecode = () => {
                logo1.complete = true;
                logo1.naturalWidth = 400;
                logo1.naturalHeight = 100;
                resolve();
            };
        });

    slide0.childrenBySelector.set('.hero-backdrop', backdrop0);
    slide1.childrenBySelector.set('.hero-backdrop', backdrop1);
    slide1.childrenBySelector.set('.hero-logo', logo1);
    slide1.childrenBySelector.set('.hero-logo-container', logoContainer1);
    slide1.childrenBySelector.set('.hero-blurhash-canvas', canvas1);

    const dots = [
        createMockElement('div', ['hero-dot', 'active'], { index: '0' }),
        createMockElement('div', ['hero-dot'], { index: '1' })
    ];
    container.childrenAllBySelector.set('.hero-item', [slide0, slide1]);
    container.childrenAllBySelector.set('.hero-dot', dots);
    container.childrenAllBySelector.set('.hero-logo', [createMockElement('img', ['hero-logo']), logo1]);
    container.childrenAllBySelector.set('.hero-blurhash-canvas', []);

    try {
        carousel.init(container);
        carousel._preloadSlide(1);

        assert.ok(backdropImgInstance, 'Backdrop loader Image should be constructed');
        assert.equal(
            backdropImgInstance.onload,
            null,
            'When img.decode is supported, img.onload must NOT race ahead of decode()'
        );
        assert.equal(logo1.onload, null, 'When logo.decode is supported, logo.onload must NOT short-circuit decode()');
        assert.equal(canvas1.style.opacity, '1', 'BlurHash must stay visible until backdrop decode() settles');
        assert.equal(backdrop1.children.length, 0, 'Inactive backdrop must stay off-DOM during decode');

        resolveBackdropDecode();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(canvas1.style.opacity, '0', 'BlurHash must fade once backdrop decode() settles');
        assert.equal(backdrop1.children.length, 0, 'Inactive Slide 1 <img> remains off-DOM after pre-decode');
        assert.ok(carousel._decodedBackdrops[1] === backdropImgInstance, 'Pre-decoded Image must be kept in _decodedBackdrops');
        assert.equal(logoContainer1.style.height, undefined, 'Logo height must wait until logo.decode() resolves');

        resolveLogoDecode();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(logoContainer1.style.height, '100px', 'Logo container must adjust after logo decode');
        assert.ok(carousel._retainedImages.includes(logo1), 'Decoded logo must be retained in _retainedImages');

        // Switching to Slide 1 swaps in the pre-decoded <img> immediately without re-decoding
        carousel.goTo(1);
        assert.equal(backdrop1.children[0], backdropImgInstance, 'goTo(1) must attach pre-decoded <img> onto active slide');
    } finally {
        nextImageFactory = null;
        globalThis.window.__scrollController = prevSc;
        carousel.destroy();
    }
});

test('HeroCarousel: defers _startAutoScroll out of synchronous scroll:finished callback', async () => {
    storageMap.clear();
    storageMap.set('pref:heroCarouselIndicatorStyle', 'dots');
    const mockSc = { isAnimating: true };
    const prevSc = globalThis.window.__scrollController;
    globalThis.window.__scrollController = mockSc;

    const carousel = new HeroCarousel({
        items: [{ Id: 'a', Name: 'A' }, { Id: 'b', Name: 'B' }]
    });
    const container = createMockElement('div', ['hero-carousel-container']);
    container.parentElement = createMockElement('div', ['hero-placeholder']);
    container.childrenAllBySelector.set('.hero-item', [
        createMockElement('div', ['hero-item', 'active']),
        createMockElement('div', ['hero-item'])
    ]);
    container.childrenAllBySelector.set('.hero-dot', [
        createMockElement('div', ['hero-dot', 'active'], { index: '0' }),
        createMockElement('div', ['hero-dot'], { index: '1' })
    ]);
    container.childrenAllBySelector.set('.hero-logo', []);
    container.childrenAllBySelector.set('.hero-blurhash-canvas', []);

    let startCalls = 0;
    const origStart = carousel._startAutoScroll.bind(carousel);
    carousel._startAutoScroll = (opts) => {
        startCalls++;
        return origStart(opts);
    };

    try {
        carousel.init(container);
        startCalls = 0;
        carousel._handleFocus();
        assert.equal(startCalls, 0, 'Must defer auto-scroll start while scroll is animating');

        mockSc.isAnimating = false;
        eventBus.emit('scroll:finished');
        assert.equal(startCalls, 0, 'Must NOT invoke _startAutoScroll synchronously inside ScrollController.finish');

        await new Promise((r) => setTimeout(r, 80));
        assert.equal(startCalls, 1, 'Deferred auto-scroll timer must run cleanly ~60ms post-finish');
    } finally {
        globalThis.window.__scrollController = prevSc;
        carousel.destroy();
    }
});

test('HeroCarousel: re-checks scroll state when the deferred timer fires and re-arms behind scroll:finished', async () => {
    storageMap.clear();
    storageMap.set('pref:heroCarouselIndicatorStyle', 'dots');
    const mockSc = { isAnimating: false };
    const prevSc = globalThis.window.__scrollController;
    globalThis.window.__scrollController = mockSc;

    const carousel = new HeroCarousel({
        items: [{ Id: 'a', Name: 'A' }, { Id: 'b', Name: 'B' }]
    });
    carousel._container = createMockElement('div', ['hero-carousel-container']);
    carousel._isVisible = true;

    let startCalls = 0;
    carousel._startAutoScroll = () => {
        startCalls++;
    };

    try {
        // Visible callback decided to resume, then the user started a new scroll
        // before the settle timer fired.
        carousel._schedulePostScrollAutoStart(10);
        mockSc.isAnimating = true;

        await new Promise((r) => setTimeout(r, 40));
        assert.equal(startCalls, 0, 'Must not start auto-scroll when a scroll began inside the settle window');
        assert.ok(carousel._observerScrollFinishHandler, 'Must re-arm behind scroll:finished instead of starting');

        mockSc.isAnimating = false;
        eventBus.emit('scroll:finished');
        assert.equal(startCalls, 0, 'Resume must still be deferred out of the scroll:finished callback turn');

        await new Promise((r) => setTimeout(r, 230));
        assert.equal(startCalls, 1, 'Must resume once scroll:finished + 200ms settle window elapses');
    } finally {
        globalThis.window.__scrollController = prevSc;
        carousel.destroy();
    }
});

// ============================================================================
// 4. Part 3 Cluster 2 — LazyLoader & ScrollController.finish Protections
// ============================================================================

test('LazyLoader: queues post-scroll intersections during quiet window and defers _shimmerObserver mutations', async () => {
    const mainObserver = ioInstances.find((io) => io.options.rootMargin !== '0px');
    const shimmerObserver = ioInstances.find((io) => io.options.rootMargin === '0px');
    assert.ok(mainObserver && shimmerObserver, 'Both main and shimmer IntersectionObservers must exist');

    lazyLoader._pendingElements = [];
    lazyLoader._pendingShimmerStates.clear();
    const mockSc = { isAnimating: false };
    const prevSc = globalThis.window.__scrollController;
    globalThis.window.__scrollController = mockSc;
    try {

    // Emit scroll:finished -> refreshes cooldown so immediate observer callback queues instead of loading
    eventBus.emit('scroll:finished');

    const img = createMockElement('img');
    img.decoding = 'auto';
    img.dataset = { src: 'http://test/post-finish-card.jpg' };
    mainObserver.cb([{ target: img, isIntersecting: true }], mainObserver);
    assert.equal(img.src, '', 'Post-finish observer delivery inside cooldown must queue instead of mutating img.src');
    assert.equal(lazyLoader._pendingElements.includes(img), true);

    const cardImage = createMockElement('div', ['card-image', 'skeleton-shimmer', 'shimmer-hidden']);
    shimmerObserver.cb([{ target: cardImage, isIntersecting: true }], shimmerObserver);
    assert.equal(
        cardImage.classList.contains('shimmer-hidden'),
        true,
        '_shimmerObserver must defer shimmer-hidden removal while user activity cooldown is active'
    );
    assert.equal(lazyLoader._pendingShimmerStates.get(cardImage), true);

    // Wait past 800ms cooldown and trigger settle flush
    await new Promise((r) => setTimeout(r, 860));
    assert.equal(
        cardImage.classList.contains('shimmer-hidden'),
        false,
        'Queued shimmer state must flush once quiet settle window elapses'
    );
    assert.equal(lazyLoader._pendingShimmerStates.size, 0);

    // Verify clearContainer prunes torn-down nodes from _pendingShimmerStates
    const staleCard = createMockElement('div', ['card-image', 'skeleton-shimmer']);
    const container = createMockElement('div');
    container.appendChild(staleCard);
    lazyLoader._pendingShimmerStates.set(staleCard, false);
    lazyLoader.clearContainer(container);
    assert.equal(lazyLoader._pendingShimmerStates.has(staleCard), false);
    } finally {
        globalThis.window.__scrollController = prevSc;
    }
});

test('ScrollController: defers scroll:finished to macrotask, cancels on rapid retarget, and avoids Frame-K double writes', async () => {
    const sc = new ScrollController();
    let finishEvents = 0;
    const onFinish = () => {
        finishEvents++;
    };
    eventBus.on('scroll:finished', onFinish);

    try {
        // 1. Synchronous instant/cancel check must NOT emit synchronously inside frame/handler
        sc.cancelAnimation('vertical');
        assert.equal(finishEvents, 0, 'scroll:finished must defer out of the current synchronous stack');

        // 2. Starting a new scroll before the 0ms macrotask fires must cancel stale finish emission
        sc._pauseImagePrewarm();
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(finishEvents, 0, '_pauseImagePrewarm must cancel pending deferred scroll:finished emit');

        // 3. Letting settle macrotask complete emits scroll:finished once
        sc._checkScrollFinished();
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(finishEvents, 1, 'Settled scroll must emit scroll:finished on next macrotask turn');

        // 4. Spring loop completion Frame K must call _finalize once without calling _write first
        let writeCount = 0;
        let finalizeCount = 0;
        rafQueue.length = 0;
        sc._verticalScrollState = sc._createPhysicsState({
            engine: 'chase',
            axis: 'vertical',
            container: { scrollTop: 0 },
            track: null,
            scrollMode: 'native',
            current: 99.8,
            target: 100,
            duration: 180,
            _write: () => {
                writeCount++;
            },
            _finalize: () => {
                finalizeCount++;
            }
        });
        sc._runSpringLoop('_verticalScrollState', '_verticalScrollAnimationId');
        let frameNow = 1000;
        let lastWrites = 0;
        for (let frame = 0; frame < 40 && sc._verticalScrollState; frame++) {
            lastWrites = writeCount;
            const pending = rafQueue.splice(0, rafQueue.length);
            for (const item of pending) {
                item.cb(frameNow);
            }
            frameNow += 16.7;
        }
        assert.equal(finalizeCount, 1, 'Settled frame must call _finalize once');
        assert.equal(
            writeCount,
            lastWrites,
            'Settled Frame K must skip redundant _write before calling _finalize'
        );
    } finally {
        eventBus.off('scroll:finished', onFinish);
        sc.resetCache();
    }
});

// ============================================================================
// 5. Staggered HeroCarousel Warm, LazyLoader Decode, CSS Containment & Easing Frame-K
// ============================================================================

test('HeroCarousel: staggers slide preloads behind idleGate every 100ms, retains off-DOM Images, and defers IO timer start', async () => {
    rafQueue.length = 0;
    storageMap.clear();
    storageMap.set('pref:heroCarouselStyle', 'immersive-performance');
    storageMap.set('pref:heroCarouselIndicatorStyle', 'dots');
    const prevSc = globalThis.window.__scrollController;
    globalThis.window.__scrollController = { isAnimating: false };

    const css = readSrc('src/styles/hero-carousel.css');
    const carouselSrc = readSrc('src/ui/HeroCarousel.js');

    // Pin compositor layer + contain boundaries, remove .hero-item--prewarm bloat
    assert.match(
        css,
        /\.hero-carousel\s*\{[\s\S]*will-change:\s*transform;[\s\S]*backface-visibility:\s*hidden;[\s\S]*contain:\s*layout style paint;/,
        '.hero-carousel must pin its compositor layer and isolate layout/style/paint across offscreen scroll cycles'
    );
    assert.match(
        css,
        /\.hero-logo-container\s*\{[\s\S]*contain:\s*layout style;/,
        '.hero-logo-container must isolate layout/style invalidation'
    );
    assert.match(css, /\.hero-backdrop-img\s*\{[\s\S]*object-fit:\s*cover;/, '.hero-backdrop-img style rule must exist');
    assert.ok(!css.includes('.hero-item--prewarm'), '.hero-item--prewarm CSS bloat must be removed');
    assert.ok(!carouselSrc.includes('hero-item--prewarm'), 'HeroCarousel.js must not add .hero-item--prewarm');
    assert.ok(!carouselSrc.includes('_prewarmHeroImages'), 'Duplicate _prewarmHeroImages ImageCache blast must be removed');

    // Verify IntersectionObserver resumption never mutates DOM/timers synchronously mid-scroll
    assert.match(
        carouselSrc,
        /IntersectionObserver\([\s\S]*eventBus\.once\('scroll:finished',\s*this\._observerScrollFinishHandler\)[\s\S]*_schedulePostScrollAutoStart\(200\)/,
        'IntersectionObserver visibility resumption must defer behind scroll:finished + 200ms settle window'
    );

    const items = [0, 1, 2, 3].map((i) => ({ Id: `s-${i}`, Name: `Show ${i}` }));
    const carousel = new HeroCarousel({ items });

    const container = createMockElement('div', ['hero-carousel-container']);
    container.parentElement = createMockElement('div', ['hero-placeholder']);
    const slides = items.map((_, i) => createMockElement('div', i === 0 ? ['hero-item', 'active'] : ['hero-item']));
    const backdrops = items.map((_, i) =>
        createMockElement('div', ['hero-backdrop'], { backdrop: `http://test/b${i}.jpg` })
    );
    const dots = items.map((_, i) =>
        createMockElement('div', i === 0 ? ['hero-dot', 'active'] : ['hero-dot'], { index: String(i) })
    );

    slides.forEach((s, i) => s.childrenBySelector.set('.hero-backdrop', backdrops[i]));
    container.childrenAllBySelector.set('.hero-item', slides);
    container.childrenAllBySelector.set('.hero-dot', dots);
    container.childrenAllBySelector.set('.hero-logo', []);
    container.childrenAllBySelector.set('.hero-blurhash-canvas', []);

    // Lightweight DOM child tracking on backdrops for this mock element stub
    backdrops.forEach((b) => {
        b.children = [];
        Object.defineProperty(b, 'firstChild', { get: () => b.children[0] || null });
        b.appendChild = (c) => {
            if (!b.children.includes(c)) b.children.push(c);
            c.parentNode = b;
            return c;
        };
        b.insertBefore = (c, ref) => {
            const idx = ref ? b.children.indexOf(ref) : -1;
            if (idx === -1) b.children.push(c);
            else b.children.splice(idx, 0, c);
            c.parentNode = b;
            return c;
        };
        b.removeChild = (c) => {
            const idx = b.children.indexOf(c);
            if (idx !== -1) b.children.splice(idx, 1);
            c.parentNode = null;
            return c;
        };
    });

    try {
        carousel.init(container);
        await Promise.resolve();
        await Promise.resolve();

        // Inactive Slide 1 preloaded via _preloadSlide stays off-DOM until goTo(1)
        carousel._preloadSlide(1);
        await Promise.resolve();
        await Promise.resolve();
        assert.ok(carousel._decodedBackdrops[1], 'Slide 1 Image must be retained in _decodedBackdrops');
        assert.ok(
            carousel._retainedImages.includes(carousel._decodedBackdrops[1]),
            'Slide 1 Image must be retained in _retainedImages'
        );
        assert.equal(backdrops[1].children.length, 0, 'Inactive Slide 1 <img> must stay off-DOM before goTo(1)');

        // Switching to Slide 1 attaches the pre-decoded <img> immediately
        carousel.goTo(1);
        assert.equal(backdrops[1].children[0], carousel._decodedBackdrops[1], 'goTo(1) must mount decoded <img> into DOM');

        // Detaching inactive slides after crossfade removes Slide 0 from DOM while retaining its Image
        carousel._detachInactiveBackdrops(1);
        assert.equal(backdrops[0].children.length, 0, 'Inactive Slide 0 <img> must detach after crossfade settles');
        assert.ok(carousel._decodedBackdrops[0], 'Detached Slide 0 Image stays cached in _decodedBackdrops');

        // Sequential stack preload uses 100ms spacing timer + idleGate
        assert.ok(carousel._stackPreloadTimerId !== null, 'init() must schedule 100ms sequential stack preload');
    } finally {
        globalThis.window.__scrollController = prevSc;
        carousel.destroy();
        assert.equal(carousel._retainedImages.length, 0, 'destroy() must release _retainedImages');
        assert.equal(carousel._stackPreloadTimerId, null, 'destroy() must cancel stack preload timer');
    }
});

test('LazyLoader: awaits img.decode() before marking loaded and honors bounded waitForContainerDecode', async () => {
    const container = createMockElement('div');
    const parent = createMockElement('div', ['card-image', 'skeleton-shimmer']);
    const img = createMockElement('img', ['card-img'], { src: 'http://test/row4-card.jpg' });

    let resolveDecode;
    img.decode = () =>
        new Promise((resolve) => {
            resolveDecode = resolve;
        });

    parent.appendChild(img);
    container.appendChild(parent);
    container.childrenAllBySelector.set('img[data-src]', [img]);

    lazyLoader.forceLoad(img);
    assert.equal(typeof img.onload, 'function', 'Shared handler must bind img.onload');

    // Simulate network load completion while decode() is still pending
    img.onload();
    assert.equal(
        img.classList.contains('loaded'),
        false,
        'Image must wait for off-thread img.decode() before marking loaded'
    );

    let decodeWaited = false;
    const waitPromise = lazyLoader.waitForContainerDecode(container, 500).then(() => {
        decodeWaited = true;
    });
    await Promise.resolve();
    assert.equal(decodeWaited, false, 'waitForContainerDecode stays pending until img.decode resolves');

    resolveDecode();
    await waitPromise;
    assert.equal(decodeWaited, true, 'waitForContainerDecode resolves once img.decode() completes');
    assert.equal(img.classList.contains('loaded'), true, 'Image marks loaded after decode() completes');

    // Bounded timeout cap guarantees slow/stalled images never hang splash
    const slowImg = createMockElement('img', ['card-img'], { src: 'http://test/stalled.jpg' });
    slowImg.decode = () => new Promise(() => {});
    const slowContainer = createMockElement('div');
    slowContainer.appendChild(slowImg);
    slowContainer.childrenAllBySelector.set('img[data-src]', [slowImg]);
    lazyLoader.forceLoad(slowImg);

    const startMs = Date.now();
    await lazyLoader.waitForContainerDecode(slowContainer, 45);
    assert.ok(Date.now() - startMs < 350, 'waitForContainerDecode must resolve within its timeout budget');
    lazyLoader.clearContainer(slowContainer);
});

test('Layout containment & passive listeners: home.css .media-row containment and passive scroll hooks', () => {
    const homeCss = readSrc('src/styles/home.css');
    const mediaRowMatch = homeCss.match(/^\.media-row\s*\{([^}]+)\}/m);
    assert.ok(mediaRowMatch, '.media-row rule must exist in home.css');
    assert.match(
        mediaRowMatch[1],
        /contain:\s*layout\s+style\s+paint\s*;/,
        '.media-row must declare layout style paint containment'
    );

    const lazyJs = readSrc('src/utils/LazyLoader.js');
    assert.match(
        lazyJs,
        /window\.addEventListener\(\s*'scroll'[\s\S]*?\{\s*capture:\s*true,\s*passive:\s*true\s*\}/,
        'LazyLoader global scroll listener must opt into capture + passive'
    );

    const sidebarJs = readSrc('src/components/Sidebar.js');
    assert.match(
        sidebarJs,
        /contentContainer\.addEventListener\(\s*'scroll'[\s\S]*?\{\s*passive:\s*true\s*\}/,
        'Sidebar scroll indicator sync listener must be passive'
    );
});

test('ScrollController: easing smoothScrollTo suppresses sub-0.5px tail deltas and avoids Frame-K double writes', async () => {
    storageMap.clear();
    const sc = new ScrollController();
    sc.getScrollPhysics = () => 'easing';
    sc.getVerticalScrollMode = () => 'native';

    const writes = [];
    const container = {
        _top: 0,
        scrollLeft: 0,
        scrollWidth: 1920,
        clientWidth: 1920,
        scrollHeight: 3000,
        clientHeight: 1080,
        style: {},
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        querySelector: () => null,
        get scrollTop() {
            return this._top;
        },
        set scrollTop(v) {
            writes.push(v);
            this._top = v;
        }
    };

    try {
        rafQueue.length = 0;
        sc.smoothScrollTo(container, 500, 100, 'vertical');

        // Tick 0: initializes startTime at t = 1000 (progress 0 -> writes 0)
        // Tick 1: 99.9% through active duration (within <0.5px of target -> writes ~499.99)
        // Tick 2: 99.95% through active duration (sub-0.5px delta -> suppressed!)
        // Tick 3 (Frame K): past duration end (progress 1 -> single exact write to 500)
        const dur = sc._verticalScrollState.duration;
        const timestamps = [1000, 1000 + dur * 0.999, 1000 + dur * 0.9995, 1000 + dur + 10];
        let writesBeforeFinalFrame = 0;
        for (let i = 0; i < timestamps.length && sc._verticalScrollState; i++) {
            if (i === timestamps.length - 1) {
                writesBeforeFinalFrame = writes.length;
            }
            const batch = rafQueue.splice(0, rafQueue.length);
            for (const item of batch) {
                item.cb(timestamps[i]);
            }
        }

        // Wait microtask/macrotask from deferred _checkScrollFinished cleanup
        await new Promise((r) => setTimeout(r, 15));
        assert.equal(writesBeforeFinalFrame, 2, 'Sub-0.5px tail write must be suppressed before Frame K');
        assert.equal(container.scrollTop, 500, 'Final settled scrollTop must equal exact target');
        assert.equal(
            writes.length - writesBeforeFinalFrame,
            1,
            'Frame K must execute a single write directly to target without an intermediate write first'
        );
    } finally {
        sc.resetCache();
    }
});

// ============================================================================
// 5. Part 5 — HeroCarousel Pass-1 GPU Warmup, HomePage Batching & BlurHash Deferral
// ============================================================================

test('HeroCarousel Pass-1 optimization: single RenderSurface mask on immersive-performance and 2-rAF GPU warmup', async () => {
    const css = readSrc('src/styles/hero-carousel.css');
    assert.match(
        css,
        /\.hero-carousel-container\.immersive-performance\s+\.hero-item\s*\{[^}]*-webkit-mask-image:\s*none\s*;[^}]*mask-image:\s*none\s*;/,
        'immersive-performance .hero-item must drop its stacked mask so only one RenderSurface exists'
    );
    assert.match(
        css,
        /\.hero-carousel-container\.immersive-performance\s+\.hero-backdrop\s*\{[^}]*-webkit-mask-composite:\s*source-in\s*;[^}]*mask-composite:\s*intersect\s*;/,
        'immersive-performance .hero-backdrop must intersect horizontal and vertical gradients on a single mask layer'
    );
    assert.match(
        css,
        /\.hero-item\.hero-item--gpu-warm\s*\{[^}]*opacity:\s*0\.001\s*;/,
        'hero-carousel.css must define .hero-item--gpu-warm with non-zero opacity for brief GPU layer upload'
    );

    rafQueue.length = 0;
    const prevSc = globalThis.window.__scrollController;
    globalThis.window.__scrollController = { isAnimating: false };

    const container = createMockElement('div', ['hero-carousel-container']);
    container.parentElement = createMockElement('div', ['hero-placeholder']);
    const slide0 = createMockElement('div', ['hero-item', 'active'], { index: '0' });
    const slide1 = createMockElement('div', ['hero-item'], { index: '1' });
    const backdrop0 = createMockElement('div', ['hero-backdrop'], { backdrop: 'http://test/slide0.jpg' });
    const backdrop1 = createMockElement('div', ['hero-backdrop'], { backdrop: 'http://test/slide1.jpg' });
    const content0 = createMockElement('div', ['hero-content']);
    const content1 = createMockElement('div', ['hero-content']);
    slide0.appendChild(backdrop0);
    slide0.appendChild(content0);
    slide1.appendChild(backdrop1);
    slide1.appendChild(content1);
    container.appendChild(slide0);
    container.appendChild(slide1);

    for (const b of [backdrop0, backdrop1]) {
        b.children = [];
        Object.defineProperty(b, 'firstChild', { get: () => b.children[0] || null });
        b.appendChild = (c) => {
            if (!b.children.includes(c)) b.children.push(c);
            c.parentNode = b;
            return c;
        };
        b.insertBefore = (c, ref) => {
            const idx = ref ? b.children.indexOf(ref) : -1;
            if (idx === -1) b.children.push(c);
            else b.children.splice(idx, 0, c);
            c.parentNode = b;
            return c;
        };
        b.removeChild = (c) => {
            const idx = b.children.indexOf(c);
            if (idx !== -1) b.children.splice(idx, 1);
            c.parentNode = null;
            return c;
        };
    }

    const dot0 = createMockElement('div', ['hero-dot', 'active'], { index: '0' });
    const dot1 = createMockElement('div', ['hero-dot'], { index: '1' });

    container.childrenAllBySelector.set('.hero-item', [slide0, slide1]);
    container.childrenAllBySelector.set('.hero-backdrop', [backdrop0, backdrop1]);
    container.childrenAllBySelector.set('.hero-dot', [dot0, dot1]);
    container.childrenAllBySelector.set('.hero-logo', []);
    container.childrenAllBySelector.set('.hero-blurhash-canvas', []);
    container.childrenAllBySelector.set('button', []);
    slide0.childrenBySelector.set('.hero-backdrop', backdrop0);
    slide1.childrenBySelector.set('.hero-backdrop', backdrop1);
    slide0.childrenBySelector.set('.hero-content', content0);
    slide1.childrenBySelector.set('.hero-content', content1);

    const carousel = new HeroCarousel([
        { Id: 'hero-0', Name: 'Slide Zero' },
        { Id: 'hero-1', Name: 'Slide One' }
    ]);

    try {
        carousel.init(container);
        await Promise.resolve();

        carousel._preloadSlide(1);
        await Promise.resolve();
        await Promise.resolve();

        // GPU warmup waits for the next animation frame so decode microtasks stay non-blocking
        assert.ok(carousel._warmSlideRafId !== null, 'Slide 1 must schedule GPU warmup pass after decode');
        assert.equal(backdrop1.children.length, 0, 'Inactive Slide 1 <img> waits for warmup rAF before mounting');

        // Frame 1: mounts decoded <img> behind active slide with .hero-item--gpu-warm
        flushOneRaf();
        assert.equal(slide1.classList.contains('hero-item--gpu-warm'), true, 'Slide 1 must receive .hero-item--gpu-warm');
        assert.equal(backdrop1.children[0], carousel._decodedBackdrops[1], 'Decoded <img> must mount during warmup pass');

        // Frame 2: remains composited for GPU texture upload
        flushOneRaf();
        assert.equal(slide1.classList.contains('hero-item--gpu-warm'), true, 'Warmup class stays across first commit frame');

        // Frame 3: detaches back off-DOM and marks Slide 1 GPU-warmed
        flushOneRaf();
        assert.equal(slide1.classList.contains('hero-item--gpu-warm'), false, 'Warmup class clears after second frame');
        assert.equal(backdrop1.children.length, 0, 'Warmup <img> must detach off-DOM after GPU texture upload');
        assert.equal(Boolean(carousel._warmedSlides[1]), true, 'Slide 1 must be marked GPU-warmed once pass completes');

        // Re-arm and verify goTo(1) cancels active GPU warmup cleanly before activating slide 1
        delete carousel._warmedSlides[1];
        carousel._warmSlideGpuCache(1);
        flushOneRaf();
        assert.equal(slide1.classList.contains('hero-item--gpu-warm'), true);
        carousel.goTo(1);
        assert.equal(slide1.classList.contains('hero-item--gpu-warm'), false, 'goTo() must cancel active GPU warmup');
        assert.equal(backdrop1.children[0], carousel._decodedBackdrops[1], 'goTo(1) must display Slide 1 <img>');
    } finally {
        globalThis.window.__scrollController = prevSc;
        carousel.destroy();
    }
});

test('HomePage batching & restore: yields between batch row mounts, defers cache walk until scroll idle, and restores scrollTop before focusing', async () => {
    const homeJs = readSrc('src/pages/HomePage.js');

    // Extract _acquireRowRenderTurn and _scheduleDeferredBatchCacheRefresh into VM to test runtime behavior
    const turnStart = homeJs.indexOf('_acquireRowRenderTurn() {');
    const turnEnd = homeJs.indexOf('async _loadAndRenderRow(', turnStart);
    assert.ok(turnStart !== -1 && turnEnd !== -1, '_acquireRowRenderTurn must exist in HomePage.js');

    const cacheStart = homeJs.indexOf('_scheduleDeferredBatchCacheRefresh() {');
    const cacheEnd = homeJs.indexOf('_setupHomeScrollObserver() {', cacheStart);
    assert.ok(cacheStart !== -1 && cacheEnd !== -1, '_scheduleDeferredBatchCacheRefresh must exist in HomePage.js');

    const turnMethodSrc = homeJs.slice(turnStart, turnEnd).replace(/\/\*\*[\s\S]*?\*\/\s*$/, '');
    const cacheMethodSrc = homeJs.slice(cacheStart, cacheEnd).replace(/\/\*\*[\s\S]*?\*\/\s*$/, '');

    const scheduledIdleCbs = [];
    const mockIdleGate = {
        runWhenIdle: (cb) => {
            scheduledIdleCbs.push(cb);
            return scheduledIdleCbs.length;
        }
    };
    const mockScrollController = { isAnimating: true };

    const Harness = vm.runInNewContext(
        `(function(idleGate, scrollController) {
            return class MockHomePage {
                constructor() {
                    this._isMounted = true;
                    this._wasPageCached = false;
                    this._rowRenderQueue = Promise.resolve();
                    this._rowRenderGateActive = false;
                    this._hasRenderedRowInTurn = false;
                    this._deferredCacheTask = null;
                    this.prewarmCalls = 0;
                    this.saveCalls = 0;
                }
                _prewarmScrollCache() { this.prewarmCalls++; }
                _savePageCache() { this.saveCalls++; }
                ${turnMethodSrc}
                ${cacheMethodSrc}
            };
        })`,
        { Promise, setTimeout }
    )(mockIdleGate, mockScrollController);

    const instance = new Harness();
    instance._rowRenderGateActive = true;

    // 3 concurrent row turn acquisitions: row 0 runs first, row 1 & 2 yield separate macrotask ticks
    const events = [];
    const rowJob = async (idx) => {
        events.push(`acquire:${idx}`);
        await instance._acquireRowRenderTurn();
        events.push(`render:${idx}`);
    };
    await Promise.all([rowJob(0), rowJob(1), rowJob(2)]);
    assert.deepEqual(
        events,
        ['acquire:0', 'acquire:1', 'acquire:2', 'render:0', 'render:1', 'render:2'],
        'Subsequent rows under _rowRenderGateActive must serialize cleanly in order across turns'
    );

    // _scheduleDeferredBatchCacheRefresh must re-defer if scrollController.isAnimating is true when fired
    instance._scheduleDeferredBatchCacheRefresh();
    assert.equal(scheduledIdleCbs.length, 1);
    scheduledIdleCbs.shift()();
    assert.equal(instance.prewarmCalls, 0, 'Must not prewarm scroll cache while scrollController.isAnimating is true');
    assert.equal(scheduledIdleCbs.length, 1, 'Must re-arm deferred cache refresh when scroll is active');

    mockScrollController.isAnimating = false;
    scheduledIdleCbs.shift()();
    assert.equal(instance.prewarmCalls, 1, 'Must prewarm scroll cache once idle and not scrolling');
    assert.equal(instance.saveCalls, 1, 'Must save page cache once idle when uncached');

    // Step 9 else and _loadBackgroundRows must defer _prewarmScrollCache / _savePageCache cleanly
    const step9ElseIdx = homeJs.indexOf('if (this._deferredDescriptors.length > 0)');
    assert.ok(step9ElseIdx !== -1);
    const step9Slice = homeJs.slice(step9ElseIdx, step9ElseIdx + 600);
    assert.equal(
        step9Slice.includes('this._prewarmScrollCache('),
        false,
        'Step 9 else branch must not call _prewarmScrollCache synchronously at splash dismissal'
    );
    assert.ok(
        step9Slice.includes('this._scheduleDeferredBatchCacheRefresh()'),
        'Step 9 else branch must schedule deferred cache refresh'
    );

    const bgStart = homeJs.indexOf('async _loadBackgroundRows(');
    const bgSlice = homeJs.slice(bgStart, bgStart + 900);
    assert.ok(bgSlice.includes('this._rowRenderGateActive = true'), '_loadBackgroundRows must stagger multi-row groups');
    assert.equal(bgSlice.includes('this._prewarmScrollCache('), false, '_loadBackgroundRows must not prewarm synchronously');

    // _tryInitializeFocus must snap scrollTop BEFORE focusElement({ skipVerticalScroll: hasSavedScroll })
    const focusStart = homeJs.indexOf('if (focusTargetCard && focusRowId)');
    const focusEnd = homeJs.indexOf("} else if (storage.getItem('pref:disableFocusRestore')", focusStart);
    assert.ok(focusStart !== -1 && focusEnd !== -1);
    const focusSlice = homeJs.slice(focusStart, focusEnd);
    const snapPos = focusSlice.indexOf('scrollController.smoothScrollTo(scrollContainer, pendingNav.scrollTop');
    const focusPos = focusSlice.indexOf('focusManager.focusElement(focusTargetCard');
    assert.ok(snapPos !== -1 && focusPos !== -1 && snapPos < focusPos, 'Must snap vertical scroll BEFORE focusing card');
    assert.ok(
        focusSlice.includes('skipVerticalScroll: hasSavedScroll'),
        'Must pass skipVerticalScroll so focusElement centers horizontally without triggering a second vertical scroll'
    );
});

test('ScrollController & LazyLoader: skipVerticalScroll preserves horizontal centering and source assigns before BlurHash check', () => {
    const sc = new ScrollController();
    sc.getHorizontalScrollMode = () => 'native';
    sc.getScrollPhysics = () => 'easing';
    sc.getVerticalScrollAlignment = () => 'bottom';

    const calls = [];
    sc.smoothScrollTo = (container, target, duration, axis) => {
        calls.push({ container, target, duration, axis });
    };

    const pageContent = createMockElement('div', ['page-content']);
    const row = createMockElement('section', ['media-row']);
    const rowItems = createMockElement('div', ['row-items']);
    rowItems.clientWidth = 1000;
    const track = createMockElement('div', ['row-items-track']);
    track.scrollWidth = 2400;
    const card = createMockElement('div', ['media-card']);
    card.offsetLeft = 700;
    card.offsetWidth = 200;

    pageContent.appendChild(row);
    row.appendChild(rowItems);
    rowItems.appendChild(track);
    track.appendChild(card);

    rowItems.closest = (sel) => (sel === '.media-row' ? row : null);
    rowItems.querySelector = (sel) => (sel === '.row-items-track' ? track : null);
    card.closest = (sel) => {
        if (sel === '.page-content') return pageContent;
        if (sel === '.media-row') return row;
        if (sel === '.row-items') return rowItems;
        return null;
    };

    sc.scrollIntoView(card, {}, { instantScroll: true, skipVerticalScroll: true });
    assert.equal(
        calls.filter((c) => c.axis === 'vertical').length,
        0,
        'skipVerticalScroll: true must suppress vertical row alignment scroll'
    );
    assert.equal(rowItems.scrollLeft, 300, 'skipVerticalScroll: true must still center the card horizontally');

    // LazyLoader: source assignment occurs synchronously BEFORE rAF-deferred BlurHash check
    rafQueue.length = 0;
    const parent = createMockElement('div', ['card-image']);
    const canvas = createMockElement('canvas', ['blurhash-canvas'], { blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' });
    const img = createMockElement('img', ['card-img'], { src: 'http://test/cached-poster.jpg' });
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    img.complete = true;
    img.naturalWidth = 1; // 1x1 GIF placeholder dimension before real bitmap loads!

    parent.appendChild(canvas);
    parent.appendChild(img);
    img.parentElement = parent;
    parent.childrenBySelector.set('.blurhash-canvas', canvas);

    // 1. Direct _decodeAndDrawBlurhash while src is still 1x1 GIF must NOT skip real BlurHash if pending
    lazyLoader._decodeAndDrawBlurhash(img);
    assert.equal(canvas.classList.contains('blurhash-decoded'), true, '1x1 GIF placeholder must not count as loaded real bitmap');
    lazyLoader._blurHashQueue.length = 0;
    lazyLoader._blurHashProcessing = false;

    // 2. When real bitmap finishes within the frame before rAF runs, BlurHash DCT is skipped completely
    const canvas2 = createMockElement('canvas', ['blurhash-canvas'], { blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' });
    const img2 = createMockElement('img', ['card-img'], { src: 'http://test/fast-hit.jpg' });
    const parent2 = createMockElement('div', ['card-image']);
    parent2.appendChild(canvas2);
    parent2.appendChild(img2);
    img2.parentElement = parent2;
    parent2.childrenBySelector.set('.blurhash-canvas', canvas2);

    lazyLoader._loadImage(img2);
    assert.equal(img2.src, 'http://test/fast-hit.jpg', '_loadImage must assign real image source immediately');
    assert.equal(canvas2.classList.contains('blurhash-decoded'), false, 'BlurHash must defer until next rAF');

    // Simulate instant memory-cache load completion prior to rAF callback
    img2.classList.add('loaded');
    flushOneRaf();
    assert.equal(
        canvas2.classList.contains('blurhash-decoded'),
        false,
        'Loaded memory-cache hit must skip BlurHash decoding entirely'
    );
});

