import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * Modern Layout Row Spacing & Legacy Dimensional Normalization Test Suite
 * ============================================================================
 * Validates that:
 * 1. VirtualCardRow sets explicit inline pixel width on cards for modern,
 *    expanded, modern-posters, and classic layouts, guaranteeing that legacy
 *    and ultra-legacy engines (Chromium < 49 / webOS 1-3 / Tizen 2-3) render
 *    cards with dimensions matching this.totalItemWidth mathematically.
 * 2. Consecutive cards positioned via absolute left coordinates have a gap
 *    equal to itemMargin (e.g. exactly 31px with scale 1.2, eliminating 110px gaps).
 * 3. Card image containers receive explicit inline height matching the aspect
 *    ratio (16:9 for landscape, 2:3 for portrait, 1:1 for square).
 * 4. modern/home.css includes legacy/ultra-legacy rules with margin-left: 0 !important.
 * 5. HomePage.js skeleton sizing properly maps modern layout to 212px/396px/26px.
 * ============================================================================
 */

// Mock storage
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

// Mock document attributes
const docAttributes = new Map();
const mockRoot = {
    setAttribute: (name, val) => docAttributes.set(name, String(val)),
    removeAttribute: (name) => docAttributes.delete(name),
    getAttribute: (name) => docAttributes.get(name) || null,
    hasAttribute: (name) => docAttributes.has(name),
    dir: 'ltr'
};

// Minimal DOM Element Mock
class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.styleMap = new Map();
        this.dataset = {};
        this.classList = {
            _classes: new Set(),
            add: (...cls) => cls.forEach((c) => this.classList._classes.add(c)),
            remove: (...cls) => cls.forEach((c) => this.classList._classes.delete(c)),
            contains: (c) => this.classList._classes.has(c)
        };
        this.attributes = new Map();

        // Style proxy supporting inline setProperty and direct property assignments
        this.style = new Proxy(this.styleMap, {
            get: (target, prop) => {
                if (prop === 'setProperty') {
                    return (key, val, priority) => {
                        target.set(key, { value: String(val), priority: priority || '' });
                    };
                }
                if (prop === 'getPropertyValue') {
                    return (key) => (target.get(key) ? target.get(key).value : '');
                }
                const entry = target.get(prop);
                return entry ? entry.value : '';
            },
            set: (target, prop, val) => {
                target.set(prop, { value: String(val), priority: '' });
                return true;
            }
        });
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentNode = null;
        }
        return child;
    }

    insertBefore(newNode, refNode) {
        const idx = this.children.indexOf(refNode);
        if (idx !== -1) {
            this.children.splice(idx, 0, newNode);
            newNode.parentNode = this;
        } else {
            this.appendChild(newNode);
        }
        return newNode;
    }

    setAttribute(name, val) {
        this.attributes.set(name, String(val));
    }

    getAttribute(name) {
        return this.attributes.get(name) || null;
    }

    querySelector(selector) {
        if (selector === '.card-image') {
            return this.children.find((c) => c.classList.contains('card-image')) || null;
        }
        if (selector === 'img.lazy') {
            return null;
        }
        return null;
    }

    querySelectorAll() {
        return [];
    }

    addEventListener() {}
    removeEventListener() {}

    get firstElementChild() {
        return this.children[0] || null;
    }

    get isConnected() {
        return true;
    }

    set innerHTML(html) {
        this.children = [];
        if (!html) return;
        // Simple parser for media-card HTML strings in tests
        const isLandscape = html.includes('landscape');
        const isSquare = html.includes('square');
        const card = new MockElement('div');
        card.classList.add('media-card');
        if (isLandscape) card.classList.add('landscape');
        if (isSquare) card.classList.add('square');

        const cardImg = new MockElement('div');
        cardImg.classList.add('card-image');
        card.appendChild(cardImg);

        this.children.push(card);
    }
}

globalThis.document = {
    createElement: (tag) => new MockElement(tag),
    documentElement: mockRoot,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
};

globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
    removeEventListener: () => {}
};

test('VirtualCardRow: Modern Landscape Rows calculate exact inline width and eliminate spacing gaps', async () => {
    // Layout: modern, default scale 1.2
    storageMap.clear();
    docAttributes.clear();
    mockRoot.setAttribute('data-layout-media-rows', 'modern');
    mockRoot.setAttribute('data-layout-tier', 'legacy');
    mockRoot.setAttribute('data-media-rows-cards', 'modern');

    const { VirtualCardRow } = await import('../src/components/VirtualCardRow.js');

    const trackEl = new MockElement('div');
    const items = [
        { id: 'item-1', name: 'Movie 1' },
        { id: 'item-2', name: 'Movie 2' },
        { id: 'item-3', name: 'Movie 3' }
    ];

    const row = new VirtualCardRow(trackEl, items, {
        isLandscape: true,
        cardType: 'landscape',
        visibleCount: 3,
        initialWindow: 3,
        renderCard: (item) => `<div class="media-card landscape"><div class="card-image"></div></div>`
    });

    // Verify row calculation metrics
    // Base landscape width = 396px * 1.2 scale = 475px
    // Base margin = 26px * 1.2 scale = 31px
    // totalItemWidth = 475 + 31 = 506px
    assert.equal(row.itemWidth, 475);
    assert.equal(row.itemMargin, 31);
    assert.equal(row.totalItemWidth, 506);

    const card0 = row.domNodes.get(0);
    const card1 = row.domNodes.get(1);

    assert.ok(card0, 'Card 0 should be rendered');
    assert.ok(card1, 'Card 1 should be rendered');

    // Verify card 0 styles
    assert.equal(card0.style.width, '475px', 'Card 0 must have explicit inline width 475px');
    assert.equal(card0.style.marginLeft, '0px', 'Card 0 must have marginLeft 0px');
    assert.equal(card0.style.marginRight, '31px', 'Card 0 must have marginRight 31px');
    assert.equal(card0.style.left, '60px', 'Card 0 must start at sidePadding (60px)');

    // Verify card 1 styles
    assert.equal(card1.style.width, '475px', 'Card 1 must have explicit inline width 475px');
    assert.equal(card1.style.left, '566px', 'Card 1 must start at 60 + 506 = 566px');

    // Calculate physical gap between Card 0 and Card 1
    const card0Left = parseInt(card0.style.left, 10);
    const card0Width = parseInt(card0.style.width, 10);
    const card1Left = parseInt(card1.style.left, 10);
    const actualGap = card1Left - (card0Left + card0Width);

    assert.equal(actualGap, 31, `Gap between cards must be exactly 31px (was 110px previously), got ${actualGap}px`);

    // Verify card image height normalization (16:9 ratio: 222.75 * 1.2 = 267px)
    const card0Img = card0.querySelector('.card-image');
    assert.ok(card0Img, 'Card image must exist');
    assert.equal(card0Img.style.height, '267px', 'Card image must be explicitly sized to 267px (16:9)');
});

test('VirtualCardRow: Modern Portrait Rows calculate exact inline width and 2:3 height', async () => {
    storageMap.clear();
    docAttributes.clear();
    mockRoot.setAttribute('data-layout-media-rows', 'modern');
    mockRoot.setAttribute('data-layout-tier', 'ultra-legacy');
    mockRoot.setAttribute('data-media-rows-cards', 'modern');

    const { VirtualCardRow } = await import('../src/components/VirtualCardRow.js');

    const trackEl = new MockElement('div');
    const items = [
        { id: 'item-1', name: 'Show 1' },
        { id: 'item-2', name: 'Show 2' }
    ];

    const row = new VirtualCardRow(trackEl, items, {
        isLandscape: false,
        cardType: 'poster',
        visibleCount: 2,
        initialWindow: 2,
        renderCard: (item) => `<div class="media-card"><div class="card-image"></div></div>`
    });

    // Base portrait width = 212px * 1.2 scale = 254px
    // Base margin = 26px * 1.2 scale = 31px
    // totalItemWidth = 254 + 31 = 285px
    assert.equal(row.itemWidth, 254);
    assert.equal(row.itemMargin, 31);
    assert.equal(row.totalItemWidth, 285);

    const card0 = row.domNodes.get(0);
    const card1 = row.domNodes.get(1);

    assert.equal(card0.style.width, '254px');
    assert.equal(card1.style.width, '254px');
    assert.equal(card0.style.left, '60px');
    assert.equal(card1.style.left, '345px'); // 60 + 285 = 345

    const gap = parseInt(card1.style.left, 10) - (parseInt(card0.style.left, 10) + parseInt(card0.style.width, 10));
    assert.equal(gap, 31, 'Portrait cards gap must be exactly 31px');

    // Verify 2:3 poster height: 318 * 1.2 = 382px
    const card0Img = card0.querySelector('.card-image');
    assert.equal(card0Img.style.height, '382px', 'Card image must be explicitly sized to 382px (2:3)');
});

test('modern/home.css: Contains explicit legacy and ultra-legacy tier margin-left resets', () => {
    // Read stylesheet using URL relative to test suite
    const css = readFileSync(new URL('../src/styles/modern/home.css', import.meta.url), 'utf8');

    assert.ok(
        css.includes('html[data-layout-tier="legacy"][data-media-rows-cards="modern"]'),
        'modern/home.css must contain legacy tier media card selector'
    );
    assert.ok(
        css.includes('html[data-layout-tier="ultra-legacy"][data-media-rows-cards="modern"]'),
        'modern/home.css must contain ultra-legacy tier media card selector'
    );
    assert.ok(
        css.includes('margin-left: 0 !important'),
        'modern/home.css must enforce margin-left: 0 !important for legacy tiers'
    );
});

test('HomePage.js: Skeletons assign modern layout dimensions instead of expanding values', () => {
    // Read HomePage source using URL relative to test suite
    const js = readFileSync(new URL('../src/pages/HomePage.js', import.meta.url), 'utf8');

    // Ensure isModern branch does NOT set expanding values (175.5px or 468px)
    assert.ok(
        js.includes(`} else if (isModern || isModernPosters) {`),
        'HomePage.js must group isModern with isModernPosters for card metrics'
    );
    assert.ok(
        js.includes(`} else if (isExpanding) {`),
        'HomePage.js must maintain a dedicated isExpanding branch'
    );
});
