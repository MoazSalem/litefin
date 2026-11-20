import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * LazyLoader Scroll-Paused Queue Test Suite
 * ============================================================================
 * Ensures IntersectionObserver callbacks do not execute synchronous img.src
 * mutations or BlurHash decodes while ScrollController is animating, and that
 * queued targets flush cleanly in bounded requestAnimationFrame slices once
 * scrolling settles.
 * ============================================================================
 */

// Track captured IntersectionObserver callback and RAF callbacks synchronously
let ioCallback = null;
const scheduledRafs = [];
let nextRafId = 1;

// Minimal storage mock required by StorageService during module import
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    key: (idx) => Array.from(storageMap.keys())[idx] ?? null,
    get length() {
        return storageMap.size;
    }
};

// Minimal DOM & IntersectionObserver stubs initialized prior to LazyLoader import
const windowListeners = new Map();
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    location: { hash: '#/home' },
    __scrollController: { isAnimating: false },
    IntersectionObserver: class MockIntersectionObserver {
        constructor(cb, options) {
            // Capture only the main image/row observer (has non-zero rootMargin)
            if (options && options.rootMargin !== '0px') {
                ioCallback = cb;
            }
            this.unobserved = [];
        }
        observe() {}
        unobserve(el) {
            this.unobserved.push(el);
        }
        disconnect() {}
    },
    addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
    },
    removeEventListener() {},
    requestAnimationFrame(cb) {
        const id = nextRafId++;
        scheduledRafs.push({ id, cb });
        return id;
    },
    cancelAnimationFrame(id) {
        const idx = scheduledRafs.findIndex((item) => item.id === id);
        if (idx !== -1) scheduledRafs.splice(idx, 1);
    }
};

globalThis.IntersectionObserver = globalThis.window.IntersectionObserver;
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;

globalThis.document = {
    documentElement: { dir: 'ltr' },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null
};

// Dynamic imports after globals are configured
const { eventBus } = await import('../src/core/EventBus.js');
const { lazyLoader } = await import('../src/utils/LazyLoader.js');

/**
 * Create a lightweight fake <img> node compatible with LazyLoader's loading path.
 */
function createMockImage(srcUrl) {
    const attrs = new Map();
    const classes = new Set();
    return {
        isConnected: true,
        decoding: 'auto',
        dataset: { src: srcUrl },
        crossOrigin: null,
        src: '',
        parentElement: null,
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c)
        },
        hasAttribute: (k) => attrs.has(k),
        setAttribute: (k, v) => attrs.set(k, String(v)),
        removeAttribute: (k) => attrs.delete(k),
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null)
    };
}

/**
 * Create a fake lazy row container wrapping several fake images.
 */
function createMockLazyRow(imgCount) {
    const rowImages = Array.from({ length: imgCount }, (_, i) => createMockImage(`http://example.com/row-${i}.jpg`));
    const attrs = new Map([['data-lazy-row', 'true']]);
    return {
        isConnected: true,
        _images: rowImages,
        hasAttribute: (k) => attrs.has(k),
        setAttribute: (k, v) => attrs.set(k, String(v)),
        removeAttribute: (k) => attrs.delete(k),
        querySelectorAll: (sel) => (sel === 'img[data-src]' ? rowImages : [])
    };
}

/**
 * Drain all currently queued animation frame callbacks up to a safety limit.
 */
function runOneRafTurn() {
    const pending = scheduledRafs.splice(0, scheduledRafs.length);
    for (const item of pending) {
        item.cb();
    }
    return pending.length;
}

test('LazyLoader queues intersecting elements while scrolling and flushes them in rAF batches', async () => {
    assert.ok(ioCallback, 'LazyLoader must register a main IntersectionObserver');

    // Reset queue state cleanly before test
    lazyLoader._pendingElements = [];
    scheduledRafs.length = 0;

    // 1. Simulate active scroll animation in ScrollController
    globalThis.window.__scrollController.isAnimating = true;

    const images = Array.from({ length: 8 }, (_, i) => createMockImage(`http://example.com/card-${i}.jpg`));
    ioCallback(
        images.map((img) => ({ target: img, isIntersecting: true })),
        lazyLoader.observer
    );

    // Also simulate a duplicate intersection during scroll for image[0]
    ioCallback([{ target: images[0], isIntersecting: true }], lazyLoader.observer);

    // Nothing should have started loading mid-scroll
    for (const img of images) {
        assert.equal(img.src, '', 'Image src must NOT be assigned during active scroll animation');
    }
    assert.equal(lazyLoader._pendingElements.length, 8, 'Intersecting targets should deduplicate and wait in queue');

    // 2. Finish scrolling and emit scroll:finished
    globalThis.window.__scrollController.isAnimating = false;
    eventBus.emit('scroll:finished');

    // Inside the 800ms post-scroll quiet window, nothing may flush yet
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(scheduledRafs.length, 0, 'RAF slice must NOT schedule inside the 800ms settle window');

    // Simulate another keypress starting a scroll mid-window: must cancel the pending flush
    globalThis.window.__scrollController.isAnimating = true;
    eventBus.emit('scroll:started');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(scheduledRafs.length, 0, 'scroll:started must cancel the pending 800ms flush timer');

    // Finish the second scroll and let the full 800ms quiet window elapse cleanly
    globalThis.window.__scrollController.isAnimating = false;
    eventBus.emit('scroll:finished');
    await new Promise((resolve) => setTimeout(resolve, 850));

    // Frame slice must await rAF turn before mutating DOM
    const loadedAfterSettle = images.filter((img) => img.src !== '').length;
    assert.equal(loadedAfterSettle, 0, 'RAF slice awaits animation frame turn before mutating DOM');

    runOneRafTurn();
    assert.equal(
        images.filter((img) => img.src !== '').length,
        2,
        'First animation frame slice should load at most 2 queued images'
    );
    assert.equal(images[0].decoding, 'async', 'LazyLoader must set img.decoding = async before loading');
    assert.equal(images[1].decoding, 'async', 'LazyLoader must set img.decoding = async on slice 1 items');
    assert.equal(
        images.filter((img) => img.src === '').length,
        6,
        'Remaining 6 images should wait for subsequent animation frames'
    );

    // Drain remaining slices (2 per frame)
    runOneRafTurn();
    assert.equal(images.filter((img) => img.src !== '').length, 4);
    runOneRafTurn();
    assert.equal(images.filter((img) => img.src !== '').length, 6);
    runOneRafTurn();
    assert.equal(
        images.filter((img) => img.src !== '').length,
        8,
        'Fourth animation frame slice should finish draining all 8 images'
    );
    assert.equal(lazyLoader._pendingElements.length, 0, 'Pending queue must be empty after flush');
});

test('LazyLoader: repeated D-pad keypresses extend the quiet window and never flush mid-navigation', async () => {
    lazyLoader._pendingElements = [];
    scheduledRafs.length = 0;
    globalThis.window.__scrollController.isAnimating = false;

    const img = createMockImage('http://example.com/gap.jpg');

    globalThis.window.__scrollController.isAnimating = true;
    ioCallback([{ target: img, isIntersecting: true }], lazyLoader.observer);
    assert.equal(lazyLoader._pendingElements.length, 1);

    globalThis.window.__scrollController.isAnimating = false;
    eventBus.emit('scroll:finished');

    const keydownHandlers = windowListeners.get('keydown') || [];
    assert.ok(keydownHandlers.length > 0, 'LazyLoader must track keydown activity');

    // Two key repeats 300ms apart. The original 800ms flush deadline passes at
    // t=1000, but the second press must have pushed it out to t=1600.
    await new Promise((resolve) => setTimeout(resolve, 300));
    keydownHandlers.forEach((fn) => fn());
    assert.equal(scheduledRafs.length, 0, 'No flush may start inside the D-pad repeat gap');

    await new Promise((resolve) => setTimeout(resolve, 300));
    keydownHandlers.forEach((fn) => fn());
    assert.equal(scheduledRafs.length, 0, 'No flush may start inside the D-pad repeat gap');

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(scheduledRafs.length, 0, 'Keydown activity must re-arm the settle window past its original deadline');

    // After a full quiet window the queued work drains.
    await new Promise((resolve) => setTimeout(resolve, 700));
    runOneRafTurn();
    assert.notEqual(img.src, '', 'Queued image must load once the user stops navigating');
});

test('LazyLoader yields after loading a lazy row and prunes disconnected containers', () => {
    lazyLoader._pendingElements = [];
    scheduledRafs.length = 0;
    globalThis.window.__scrollController.isAnimating = true;

    const row1 = createMockLazyRow(4);
    const row2 = createMockLazyRow(4);
    const orphanImg = createMockImage('http://example.com/orphan.jpg');

    ioCallback(
        [
            { target: row1, isIntersecting: true },
            { target: orphanImg, isIntersecting: true },
            { target: row2, isIntersecting: true }
        ],
        lazyLoader.observer
    );

    assert.equal(lazyLoader._pendingElements.length, 3);

    // Simulate container teardown removing orphanImg before flush
    const fakeContainer = {
        contains: (el) => el === orphanImg,
        querySelectorAll: () => []
    };
    lazyLoader.clearContainer(fakeContainer);
    assert.equal(lazyLoader._pendingElements.length, 2, 'clearContainer must prune queued children of destroyed pages');

    // Resume after scroll stops
    globalThis.window.__scrollController.isAnimating = false;
    lazyLoader._flushPendingElements();

    // First frame loads row1 ONLY and yields before row2 so two full rows never burst together
    runOneRafTurn();
    assert.ok(row1._images.every((img) => img.src !== ''), 'Row 1 images should load in slice 1');
    assert.ok(row2._images.every((img) => img.src === ''), 'Row 2 must wait for the next frame slice');

    // Second frame loads row2
    runOneRafTurn();
    assert.ok(row2._images.every((img) => img.src !== ''), 'Row 2 images should load in slice 2');
});
