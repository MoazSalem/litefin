import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * ============================================================================
 * HeroCarousel Slide Transition & Idle Layer-Warming Test Suite
 * ============================================================================
 * Verifies:
 *   1. Preloading decodes BOTH backdrop and logo off the main thread.
 *   2. Adjacent neighbor slides are composite-warmed (visibility: visible while
 *      opacity: 0) via an idle animation frame outside transition frames.
 *   3. goTo() reuses cached DOM node arrays & storage preferences, never sets
 *      inline style.willChange overrides, and only flips active classes.
 *   4. hero-carousel.css isolates slide layout and disables pointer events on
 *      inactive idle-warmed neighbor slides.
 * ============================================================================
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Minimal localStorage & sessionStorage mocks prior to dynamic module imports
const storageMap = new Map();
const mockStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    key: (idx) => Array.from(storageMap.keys())[idx] ?? null,
    get length() {
        return storageMap.size;
    }
};
globalThis.localStorage = mockStorage;
globalThis.sessionStorage = mockStorage;

if (!globalThis.navigator) {
    globalThis.navigator = { userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 9.0)' };
}

// Track animation frames & decoded Image instances deterministically
const scheduledRafs = [];
let nextRafId = 1;
const createdImages = [];

globalThis.requestAnimationFrame = (cb) => {
    const id = nextRafId++;
    scheduledRafs.push({ id, cb });
    return id;
};
globalThis.cancelAnimationFrame = (id) => {
    const idx = scheduledRafs.findIndex((entry) => entry.id === id);
    if (idx !== -1) scheduledRafs.splice(idx, 1);
};

// Mock Image class with async decode() support
globalThis.Image = class MockImage {
    constructor() {
        this._src = '';
        this.onload = null;
        this.onerror = null;
        this.decodeCalls = 0;
        createdImages.push(this);
    }

    set src(val) {
        this._src = val;
    }

    get src() {
        return this._src;
    }

    decode() {
        this.decodeCalls++;
        return Promise.resolve();
    }
};

// Track DOM query calls after init() so we prove goTo() does not re-query DOM
let queryAllCount = 0;
let queryOneCount = 0;

/**
 * Builds a minimal DOM node stub supporting classList, dataset, style, and tree queries.
 */
function createMockNode(classNames = [], attrs = {}) {
    const classes = new Set(classNames);
    const dataset = { ...attrs };
    const style = {};
    let decodeLogoCalls = 0;

    // Auto-track inline style property writes when testing CSS layer churn avoidance
    const styleProxy = new Proxy(style, {
        set(target, prop, val) {
            target[prop] = val;
            return true;
        }
    });

    const node = {
        dataset,
        style: styleProxy,
        naturalWidth: 400,
        naturalHeight: 100,
        complete: false,
        _src: '',
        onload: null,
        onerror: null,
        childrenBySelector: new Map(),
        childrenAllBySelector: new Map(),
        classList: {
            add: (...names) => names.forEach((n) => classes.add(n)),
            remove: (...names) => names.forEach((n) => classes.delete(n)),
            contains: (name) => classes.has(name)
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        getAttribute: (attr) => (attr === 'src' ? node._src || null : null),
        setAttribute: () => {},
        removeAttribute: () => {},
        closest: () => node._closestContainer || null,
        querySelector: (selector) => {
            queryOneCount++;
            return node.childrenBySelector.get(selector) || null;
        },
        querySelectorAll: (selector) => {
            queryAllCount++;
            return node.childrenAllBySelector.get(selector) || [];
        },
        decode: () => {
            decodeLogoCalls++;
            node.complete = true;
            return Promise.resolve();
        },
        getDecodeCount: () => decodeLogoCalls,
        get src() {
            return node._src;
        },
        set src(val) {
            node._src = val;
        }
    };

    return node;
}

// Install window & document mocks prior to HeroCarousel / IdleGate import
const docElement = createMockNode();
docElement.dir = 'ltr';

globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    location: { hash: '#/home' },
    __scrollController: { isAnimating: false },
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} })
};

globalThis.document = {
    documentElement: docElement,
    body: createMockNode(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => false
};

const { default: HeroCarousel } = await import('../src/ui/HeroCarousel.js');

/**
 * Helper to flush queued requestAnimationFrame callbacks.
 */
function flushRafs() {
    while (scheduledRafs.length > 0) {
        const next = scheduledRafs.shift();
        next.cb(16);
    }
}

/**
 * Builds a 4-slide mock container wired with slide items, dots, backdrops, logos, and containers.
 */
function buildCarouselFixture(slideCount = 4) {
    const container = createMockNode(['hero-carousel-container']);
    container.parentElement = createMockNode(['hero-placeholder']);

    const slides = [];
    const dots = [];
    const backdrops = [];
    const logos = [];
    const logoContainers = [];

    for (let i = 0; i < slideCount; i++) {
        const isFirst = i === 0;
        const slide = createMockNode(isFirst ? ['hero-item', 'active'] : ['hero-item']);
        slide.style.visibility = isFirst ? 'visible' : 'hidden';

        const backdrop = createMockNode(['hero-backdrop'], { backdrop: `http://test/backdrop-${i}.jpg` });
        if (isFirst) backdrop.style.backgroundImage = "url('http://test/backdrop-0.jpg')";

        const logoContainer = createMockNode(['hero-logo-container']);
        const logo = createMockNode(['hero-logo'], isFirst ? {} : { src: `http://test/logo-${i}.png` });
        if (isFirst) logo.src = 'http://test/logo-0.png';
        logo._closestContainer = logoContainer;

        const content = createMockNode(['hero-content']);
        slide.childrenBySelector.set('.hero-backdrop', backdrop);
        slide.childrenBySelector.set('.hero-logo', logo);
        slide.childrenBySelector.set('.hero-logo-container', logoContainer);
        slide.childrenBySelector.set('.hero-content', content);

        const dot = createMockNode(isFirst ? ['hero-dot', 'active'] : ['hero-dot'], { index: String(i) });

        slides.push(slide);
        dots.push(dot);
        backdrops.push(backdrop);
        logos.push(logo);
        logoContainers.push(logoContainer);
    }

    container.childrenAllBySelector.set('.hero-item', slides);
    container.childrenAllBySelector.set('.hero-dot', dots);
    container.childrenAllBySelector.set('.hero-logo', logos);
    container.childrenAllBySelector.set('.hero-blurhash-canvas', []);

    return { container, slides, dots, backdrops, logos, logoContainers };
}

test('CSS: inactive slides isolate layout and block pointer hit-testing', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/hero-carousel.css'), 'utf8');
    const heroItemRuleMatch = css.match(/^\.hero-item\s*\{([^}]+)\}/m);
    assert.ok(heroItemRuleMatch, 'hero-item rule should exist in hero-carousel.css');

    const heroItemBody = heroItemRuleMatch[1];
    assert.ok(heroItemBody.includes('pointer-events: none;'), '.hero-item must disable pointer events when inactive');
    assert.ok(heroItemBody.includes('contain: layout style;'), '.hero-item must isolate layout and style recalcs');

    const activeRuleMatch = css.match(/^\.hero-item\.active\s*\{([^}]+)\}/m);
    assert.ok(activeRuleMatch, 'hero-item.active rule should exist in hero-carousel.css');
    assert.ok(
        activeRuleMatch[1].includes('pointer-events: auto;'),
        '.hero-item.active must re-enable pointer events on the active slide'
    );
});

test('HeroCarousel: preloads and decodes logo+backdrop off-thread, idle-warms adjacent slide, and keeps goTo() free of DOM queries or willChange churn', async () => {
    createdImages.length = 0;
    scheduledRafs.length = 0;
    storageMap.clear();
    storageMap.set('pref:heroCarouselIndicatorStyle', 'dots');
    storageMap.set('pref:heroCarouselStyle', 'immersive-performance');

    const items = [0, 1, 2, 3].map((i) => ({ Id: `item-${i}`, Name: `Item ${i}` }));
    const carousel = new HeroCarousel({ items });
    const { container, slides, dots, backdrops, logos, logoContainers } = buildCarouselFixture(4);

    // Track storage reads triggered after initialization completes
    let storageReads = 0;
    const origGetItem = mockStorage.getItem;
    mockStorage.getItem = (key) => {
        storageReads++;
        return origGetItem(key);
    };

    try {
        carousel.init(container);
        assert.equal(slides[1].style.visibility, 'hidden', 'Adjacent slide starts hidden prior to idle decode');

        // Reset counters after init so we observe transition & preload behavior cleanly
        queryAllCount = 0;
        queryOneCount = 0;
        storageReads = 0;

        // Preload neighbor slide 1 cleanly during idle
        carousel._preloadSlide(1);

        // Backdrop Image.decode() should have been invoked off-thread
        assert.ok(createdImages.length >= 1, '_preloadSlide must instantiate backdrop loader image');
        const backdropLoader = createdImages[createdImages.length - 1];
        assert.equal(backdropLoader.decodeCalls, 1, '_preloadSlide must call img.decode() on backdrop');

        // Deferred logo must also use logo.decode() prior to compositing
        assert.equal(logos[1].getDecodeCount(), 1, '_preloadSlide must call decode() on deferred hero logo');

        // Resolve async decode microtasks
        await Promise.resolve();
        await Promise.resolve();

        // Backdrop background-image and logo container height should now be committed
        assert.equal(backdrops[1].style.backgroundImage, "url('http://test/backdrop-1.jpg')");
        assert.equal(logoContainers[1].style.height, '100px');

        // Layer warm should be queued onto a clean rAF (not synchronously flipping visibility)
        assert.equal(slides[1].style.visibility, 'hidden', 'Layer warming defers visibility mutation to idle rAF');
        flushRafs();
        assert.equal(
            slides[1].style.visibility,
            'visible',
            'Adjacent slide 1 should be idle-warmed (visibility: visible while opacity: 0) before goTo()'
        );

        // Now execute goTo(1) and assert zero DOM queries, zero storage reads, zero inline willChange churn
        const queryAllBefore = queryAllCount;
        const queryOneBefore = queryOneCount;
        const storageReadsBefore = storageReads;

        carousel.goTo(1);

        assert.equal(queryAllCount, queryAllBefore, 'goTo() must reuse cached slide/dot arrays without querySelectorAll');
        assert.equal(queryOneCount, queryOneBefore, 'goTo() must not call querySelector inside hot transition');
        assert.equal(storageReads, storageReadsBefore, 'goTo() must reuse cached preferences without storage reads');
        assert.equal(slides[0].classList.contains('active'), false);
        assert.equal(slides[1].classList.contains('active'), true);
        assert.equal(dots[1].classList.contains('active'), true);
        assert.equal(slides[1].style.willChange, undefined, 'goTo() must not set inline willChange on slide');
        assert.equal(backdrops[1].style.willChange, undefined, 'goTo() must not set inline willChange on backdrop');
        assert.equal(slides[2].style.visibility, 'hidden', 'Non-transition slide 2 remains hidden');
        assert.equal(slides[3].style.visibility, 'hidden', 'Non-transition slide 3 remains hidden');
    } finally {
        mockStorage.getItem = origGetItem;
        carousel.destroy();
    }
});
