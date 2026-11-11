import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const { default: TizenAdapter } = await import('../src/tizen/TizenAdapter.js');
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
// 2. Part 2 — TizenAdapter Compositor Warmup Behavior
// ============================================================================

test('TizenAdapter.warmupCompositor: strict Tizen isolation, AVPlay hardware init, persistent <object>, and transient <video>', () => {
    rafQueue.length = 0;
    mockBody._children.length = 0;

    const origGetById = globalThis.document.getElementById;
    const origCreateEl = globalThis.document.createElement;
    let videoLoadCalls = 0;

    globalThis.document.getElementById = (id) => mockBody._children.find((node) => node.id === id) || null;
    globalThis.document.createElement = (tag) => {
        const el = origCreateEl(tag);
        if (tag === 'video') {
            el.load = () => {
                videoLoadCalls++;
            };
        }
        return el;
    };

    try {
        let avState = 'NONE';
        let stateReads = 0;
        const openedUrls = [];
        const displayRects = [];
        let closeCalls = 0;

        globalThis.window.webapis = {
            avplay: {
                getState: () => {
                    stateReads++;
                    return avState;
                },
                open: (url) => {
                    openedUrls.push(url);
                },
                setDisplayRect: (...rect) => {
                    displayRects.push(rect);
                },
                close: () => {
                    closeCalls++;
                }
            }
        };

        // 1. Non-Tizen guard: must never touch AVPlay or mount probe/video elements
        const nonTizen = new TizenAdapter();
        nonTizen._isTizen = false;
        assert.equal(nonTizen.warmupCompositor(), false);
        assert.equal(stateReads, 0, 'Non-Tizen target must never call webapis.avplay');
        assert.equal(mockBody._children.length, 0, 'Non-Tizen target must not mount warmup nodes');

        // 2. Tizen path in NONE state: exercises native AVPlay open + setDisplayRect + close,
        // keeps persistent <object>, and detaches transient <video> after 2 rAFs.
        const tvAdapter = new TizenAdapter();
        tvAdapter._isTizen = true;
        assert.equal(tvAdapter.warmupCompositor(), true);
        assert.equal(stateReads, 1);
        assert.deepEqual(openedUrls, ['about:blank']);
        assert.deepEqual(displayRects, [[0, 0, 1, 1]]);
        assert.equal(closeCalls, 1, 'AVPlay warmup must close cleanly back to NONE');
        assert.equal(videoLoadCalls, 1, 'Hidden <video> warmup must call load() to wake media/GPU clock');

        const probe = mockBody._children.find((el) => el.id === 'litefin-avplay-warmup');
        const video = mockBody._children.find((el) => el.id === 'litefin-video-warmup');
        assert.ok(probe && probe.type === 'application/avplayer', 'Persistent AVPlayer <object> must be mounted');
        assert.equal(probe.style.pointerEvents, 'none');
        assert.equal(probe.style.opacity, '0');
        assert.ok(video && video.muted === true && video.playsInline === true, 'Transient muted <video> must mount');

        // Frame 1 keeps <video>, Frame 2 detaches <video> while keeping persistent <object> mounted
        flushOneRaf();
        assert.ok(mockBody._children.includes(video), 'Warmup <video> must stay through frame 1 commit');
        flushOneRaf();
        assert.equal(mockBody._children.includes(video), false, 'Warmup <video> must detach after frame 2');
        assert.equal(mockBody._children.includes(probe), true, 'Persistent AVPlayer <object> must remain mounted');

        // 3. Idempotency guard: second call must not reopen AVPlay or duplicate nodes
        assert.equal(tvAdapter.warmupCompositor(), true);
        assert.equal(stateReads, 1);
        assert.equal(openedUrls.length, 1);
        assert.equal(mockBody._children.length, 1);

        // 4. Active session guard: when playback is already active, never touch open/setDisplayRect/close
        avState = 'PLAYING';
        const activeSessionAdapter = new TizenAdapter();
        activeSessionAdapter._isTizen = true;
        assert.equal(activeSessionAdapter.warmupCompositor(), true);
        assert.equal(openedUrls.length, 1, 'Must never disturb active AVPlay sessions');
        assert.equal(closeCalls, 1);

        // 5. Resilience: throwing getState() must still execute dummy open -> setDisplayRect -> close safely
        globalThis.window.webapis.avplay.getState = () => {
            throw new Error('NONE state quirk');
        };
        const throwingAdapter = new TizenAdapter();
        throwingAdapter._isTizen = true;
        assert.equal(throwingAdapter.warmupCompositor(), true);
        assert.equal(openedUrls.length, 2);
        assert.equal(closeCalls, 2);
        flushOneRaf();
        flushOneRaf();
    } finally {
        mockBody._children.length = 0;
        delete globalThis.window.webapis;
        globalThis.document.getElementById = origGetById;
        globalThis.document.createElement = origCreateEl;
    }
});

// ============================================================================
// 3. Part 3 Cluster 1 — HeroCarousel CSS, Decode Ordering & Deferred AutoStart
// ============================================================================

test('HeroCarousel CSS: removes dot width layout transition and promotes prewarm content rasterization', () => {
    const css = readSrc('src/styles/hero-carousel.css');
    const dotRuleMatch = css.match(/^\.hero-dot\s*\{([^}]+)\}/m);
    assert.ok(dotRuleMatch, '.hero-dot rule must exist');
    assert.ok(
        !/transition:[^;]*\bwidth\b/.test(dotRuleMatch[1]),
        '.hero-dot must not animate width (forces flex layout thrash across indicators after goTo)'
    );

    const prewarmContentMatch = css.match(/^\.hero-item--prewarm\s+\.hero-content\s*\{([^}]+)\}/m);
    assert.ok(prewarmContentMatch, '.hero-item--prewarm .hero-content rule must exist');
    assert.ok(
        prewarmContentMatch[1].includes('opacity: 1;') && prewarmContentMatch[1].includes('transition: none;'),
        '.hero-item--prewarm .hero-content must make content paint-eligible without fade transition'
    );
});

test('HeroCarousel: _preloadSlide waits for decode() instead of premature onload and triggers neighbor prewarm', async () => {
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
    backdrop0.style.backgroundImage = "url('http://test/b0.jpg')";
    const backdrop1 = createMockElement('div', ['hero-backdrop'], { backdrop: 'http://test/b1.jpg' });

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
        assert.equal(backdrop1.style.backgroundImage, undefined, 'Backdrop must stay uncommitted until decode() settles');

        resolveBackdropDecode();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(backdrop1.style.backgroundImage, "url('http://test/b1.jpg')");
        assert.equal(carousel._decodedAssets[1], undefined, 'Slide must not mark decoded until logo decode also resolves');

        resolveLogoDecode();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(carousel._decodedAssets[1], true, 'Slide must mark decoded after both backdrop and logo decode');

        // Running the post-decode rAF should apply .hero-item--prewarm onto slide 1 for two frames
        flushOneRaf();
        assert.equal(slide1.classList.contains('hero-item--prewarm'), true);
        flushOneRaf();
        flushOneRaf();
        assert.equal(slide1.classList.contains('hero-item--prewarm'), false);
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

test('HeroCarousel: staggers neighbor prewarm strictly 1 slide per 150ms quiet tick and cancels on goTo', async () => {
    rafQueue.length = 0;
    storageMap.clear();
    storageMap.set('pref:heroCarouselStyle', 'immersive-performance');
    storageMap.set('pref:heroCarouselIndicatorStyle', 'dots');
    const prevSc = globalThis.window.__scrollController;
    globalThis.window.__scrollController = { isAnimating: false };

    const items = [0, 1, 2, 3].map((i) => ({ Id: `s-${i}`, Name: `Show ${i}` }));
    const carousel = new HeroCarousel({ items });

    const container = createMockElement('div', ['hero-carousel-container']);
    container.parentElement = createMockElement('div', ['hero-placeholder']);
    const slides = items.map((_, i) => createMockElement('div', i === 0 ? ['hero-item', 'active'] : ['hero-item']));
    const backdrops = items.map((_, i) => {
        const b = createMockElement('div', ['hero-backdrop'], { backdrop: `http://test/b${i}.jpg` });
        b.style.backgroundImage = `url('http://test/b${i}.jpg')`;
        return b;
    });
    const dots = items.map((_, i) =>
        createMockElement('div', i === 0 ? ['hero-dot', 'active'] : ['hero-dot'], { index: String(i) })
    );

    slides.forEach((s, i) => s.childrenBySelector.set('.hero-backdrop', backdrops[i]));
    container.childrenAllBySelector.set('.hero-item', slides);
    container.childrenAllBySelector.set('.hero-dot', dots);
    container.childrenAllBySelector.set('.hero-logo', []);
    container.childrenAllBySelector.set('.hero-blurhash-canvas', []);

    try {
        carousel.init(container);

        // Mark neighbors (1 and 3) already decoded; neither should warm together on one frame
        carousel._decodedAssets[1] = true;
        carousel._decodedAssets[3] = true;
        carousel._warmAdjacentSlides();

        // Frame 1: ONLY slide 1 enters .hero-item--prewarm; slide 3 stays queued
        assert.equal(slides[1].classList.contains('hero-item--prewarm'), true, 'First candidate warms immediately');
        assert.equal(
            slides[3].classList.contains('hero-item--prewarm'),
            false,
            'Second neighbor must NOT warm in the same frame'
        );

        // Two rAFs clear slide 1 and schedule the 150ms staggered tick for slide 3
        flushOneRaf();
        flushOneRaf();
        assert.equal(slides[1].classList.contains('hero-item--prewarm'), false);
        assert.equal(slides[3].classList.contains('hero-item--prewarm'), false, 'Slide 3 must wait for 150ms quiet tick');
        assert.ok(carousel._warmTimerId, '150ms stagger timer must be pending for remaining neighbor');

        // Advance past 150ms -> slide 3 warms alone
        await new Promise((r) => setTimeout(r, 175));
        assert.equal(slides[3].classList.contains('hero-item--prewarm'), true, 'Slide 3 warms after 150ms stagger tick');

        // Navigating via goTo() must abort active prewarm and cancel queue immediately
        carousel.goTo(2);
        assert.equal(slides[3].classList.contains('hero-item--prewarm'), false, 'goTo must clear active prewarm immediately');
        assert.equal(carousel._warmQueue.length, 0, 'goTo must empty pending warm queue');
    } finally {
        globalThis.window.__scrollController = prevSc;
        carousel.destroy();
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

