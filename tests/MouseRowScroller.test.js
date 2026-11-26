import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Minimal DOM & Event Environment Mock for MouseRowScroller Tests
 * ============================================================================
 */
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

globalThis.window = globalThis;

// Minimal Element base so `instanceof Element` checks pass
class MockElement {
    constructor(classes = []) {
        this._classes = new Set(classes);
        this.dataset = {};
        this._listeners = new Map();
        this.parentElement = null;
        this.children = [];
        this.classList = {
            add: (c) => this._classes.add(c),
            remove: (c) => this._classes.delete(c),
            contains: (c) => this._classes.has(c)
        };
    }

    closest(selector) {
        let cur = this;
        const cls = selector.startsWith('.') ? selector.slice(1) : null;
        while (cur) {
            if (cls && cur._classes.has(cls)) return cur;
            cur = cur.parentElement;
        }
        return null;
    }

    addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(fn);
    }

    dispatchEvent(evt) {
        let cur = this;
        while (cur) {
            const list = cur._listeners.get(evt.type) || [];
            for (const fn of list) fn(evt);
            if (!evt.bubbles) break;
            cur = cur.parentElement;
        }
        return !evt.defaultPrevented;
    }
}
globalThis.Element = MockElement;

// Minimal CustomEvent polyfill
globalThis.CustomEvent = class MockCustomEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.bubbles = Boolean(init.bubbles);
        this.cancelable = Boolean(init.cancelable);
        this.detail = init.detail || null;
        this.defaultPrevented = false;
    }
    preventDefault() {
        this.defaultPrevented = true;
    }
};

// Document event dispatcher supporting capture phase
const docListeners = new Map();
globalThis.document = {
    documentElement: {
        dir: 'ltr',
        setAttribute: () => {},
        getAttribute: () => null
    },
    body: {
        classList: { contains: () => false }
    },
    querySelector: () => null,
    addEventListener(type, fn, opts) {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push({ fn, capture: Boolean(opts && (opts === true || opts.capture)) });
    },
    removeEventListener(type, fn, opts) {
        const cap = Boolean(opts && (opts === true || opts.capture));
        const list = docListeners.get(type) || [];
        docListeners.set(
            type,
            list.filter((entry) => entry.fn !== fn || entry.capture !== cap)
        );
    },
    dispatch(type, evt) {
        evt.type = type;
        evt.defaultPrevented = false;
        evt.propagationStopped = false;
        evt.preventDefault = () => {
            evt.defaultPrevented = true;
        };
        evt.stopPropagation = () => {
            evt.propagationStopped = true;
        };
        const list = [...(docListeners.get(type) || [])];
        for (const entry of list) {
            entry.fn(evt);
        }
        return evt;
    }
};

globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { MouseRowScroller } = await import('../src/ui/MouseRowScroller.js');
const { platformInfo } = await import('../src/utils/PlatformInfo.js');

// Force web platform detection for unit tests
Object.defineProperty(platformInfo, 'isWeb', { get: () => true, configurable: true });
Object.defineProperty(platformInfo, 'isDesktop', { get: () => false, configurable: true });

function buildRowDom() {
    const syncCalls = [];
    const virtualRow = {
        totalItems: 20,
        sidePadding: 20,
        itemWidth: 160,
        totalItemWidth: 170,
        getTrackWidth: () => 20 * 170 + 40,
        getItemPosition: (i) => 20 + i * 170,
        syncScrollToPosition: (x) => syncCalls.push(x),
        endTouchScroll: () => {}
    };

    const rowItems = new MockElement(['row-items']);
    rowItems.clientWidth = 800;
    rowItems.scrollLeft = 0;

    const track = new MockElement(['row-items-track']);
    track.__virtualRow = virtualRow;
    track.parentElement = rowItems;

    const card = new MockElement(['media-card']);
    card.dataset.itemId = 'movie-123';
    card.parentElement = track;

    rowItems.querySelector = (sel) => (sel === ':scope > .row-items-track' ? track : null);

    return { rowItems, track, card, syncCalls };
}

test('MouseRowScroller: quick click on card does not trigger hold or suppress click', () => {
    const scroller = new MouseRowScroller();
    scroller.init();
    const { card } = buildRowDom();

    let longPressed = false;
    card.addEventListener('card:longpress', () => {
        longPressed = true;
    });

    globalThis.document.dispatch('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 100,
        clientY: 100,
        target: card
    });
    globalThis.document.dispatch('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 102,
        clientY: 101,
        target: card
    });

    const clickEvt = globalThis.document.dispatch('click', { target: card });
    assert.equal(longPressed, false);
    assert.equal(clickEvt.defaultPrevented, false);
    assert.equal(clickEvt.propagationStopped, false);

    scroller.destroy();
});

test('MouseRowScroller: mouse drag scrolls row, syncs VirtualCardRow, and suppresses click', () => {
    const scroller = new MouseRowScroller();
    scroller.init();
    const { rowItems, card, syncCalls } = buildRowDom();

    let longPressed = false;
    card.addEventListener('card:longpress', () => {
        longPressed = true;
    });

    globalThis.document.dispatch('pointerdown', {
        pointerId: 2,
        pointerType: 'mouse',
        button: 0,
        clientX: 300,
        clientY: 100,
        target: card
    });
    globalThis.document.dispatch('pointermove', {
        pointerId: 2,
        pointerType: 'mouse',
        clientX: 180,
        clientY: 102,
        target: card
    });

    assert.equal(rowItems.scrollLeft, 120);
    assert.equal(rowItems.classList.contains('is-dragging'), true);
    assert.equal(syncCalls.includes(120), true);

    globalThis.document.dispatch('pointerup', {
        pointerId: 2,
        pointerType: 'mouse',
        clientX: 180,
        clientY: 102,
        target: card
    });

    assert.equal(rowItems.classList.contains('is-dragging'), false);
    const clickEvt = globalThis.document.dispatch('click', { target: card });
    assert.equal(clickEvt.defaultPrevented, true);
    assert.equal(clickEvt.propagationStopped, true);
    assert.equal(longPressed, false);

    scroller.destroy();
});

test('MouseRowScroller: touch drag cancels hold, leaves native scrollLeft alone, and suppresses click', () => {
    const scroller = new MouseRowScroller();
    scroller.init();
    const { rowItems, card } = buildRowDom();

    globalThis.document.dispatch('pointerdown', {
        pointerId: 3,
        pointerType: 'touch',
        clientX: 300,
        clientY: 100,
        target: card
    });
    globalThis.document.dispatch('pointermove', {
        pointerId: 3,
        pointerType: 'touch',
        clientX: 240,
        clientY: 101,
        target: card
    });

    // Touch pan relies on native compositor rather than JS scrollLeft writes
    assert.equal(rowItems.scrollLeft, 0);

    globalThis.document.dispatch('pointerup', {
        pointerId: 3,
        pointerType: 'touch',
        clientX: 240,
        clientY: 101,
        target: card
    });

    const clickEvt = globalThis.document.dispatch('click', { target: card });
    assert.equal(clickEvt.defaultPrevented, true);
    assert.equal(clickEvt.propagationStopped, true);

    scroller.destroy();
});

test('MouseRowScroller: stationary hold fires card:longpress and suppresses click/contextmenu', async () => {
    const scroller = new MouseRowScroller();
    scroller.init();
    const { rowItems, card } = buildRowDom();

    let longPressDetail = null;
    card.addEventListener('card:longpress', (e) => {
        longPressDetail = e.detail;
    });

    globalThis.document.dispatch('pointerdown', {
        pointerId: 4,
        pointerType: 'touch',
        clientX: 150,
        clientY: 120,
        target: card
    });

    // Wait past HOLD_DURATION_MS (500ms)
    await new Promise((r) => setTimeout(r, 560));

    assert.ok(longPressDetail, 'expected card:longpress event to fire');
    assert.equal(longPressDetail.itemId, 'movie-123');
    assert.equal(longPressDetail.pointerType, 'touch');

    // Jitter after hold must not turn into a drag
    globalThis.document.dispatch('pointermove', {
        pointerId: 4,
        pointerType: 'touch',
        clientX: 180,
        clientY: 120,
        target: card
    });
    assert.equal(rowItems.scrollLeft, 0);

    globalThis.document.dispatch('pointerup', {
        pointerId: 4,
        pointerType: 'touch',
        clientX: 180,
        clientY: 120,
        target: card
    });

    const clickEvt = globalThis.document.dispatch('click', { target: card });
    const ctxEvt = globalThis.document.dispatch('contextmenu', { target: card });
    assert.equal(clickEvt.defaultPrevented, true);
    assert.equal(clickEvt.propagationStopped, true);
    assert.equal(ctxEvt.defaultPrevented, true);

    scroller.destroy();
});
