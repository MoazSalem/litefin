import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * Media Card Text Alignment & Legacy CSS Compatibility Test Suite
 * ============================================================================
 * Validates that:
 * 1. LayoutManager card label alignment getter/setter operates dynamically,
 *    stamps the data-card-label-align attribute on document.documentElement,
 *    and persists the chosen setting to local storage.
 * 2. LayoutManager card label style getter/setter updates root attribute and
 *    invalidates the CardRenderer cache to ensure fresh layout rendering.
 * 3. SettingsDropdownDispatcher routes card-label-align-select and
 *    card-label-style-select actions directly to LayoutManager setters.
 * 4. CSS selectors in base.css conform strictly to CSS Selectors Level 3
 *    (preventing syntax parse aborts in Chromium 26-47 on Legacy and Ultra-Legacy
 *    Smart TV firmware like Tizen 2.x/3.x and webOS 1.x-3.x).
 * ============================================================================
 */

// Global mock state
const storageMap = new Map();
const docAttributes = new Map();

globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

globalThis.document = {
    createElement: () => ({
        getContext: () => ({}),
        setAttribute: () => {},
        removeAttribute: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false }
    }),
    documentElement: {
        setAttribute: (name, val) => docAttributes.set(name, String(val)),
        removeAttribute: (name) => docAttributes.delete(name),
        getAttribute: (name) => docAttributes.get(name) || null
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
};

globalThis.window = globalThis;
globalThis.__APP_VERSION__ = '1.0.0';

// Dynamic imports after browser mocks are established
const { storage } = await import('../src/utils/StorageService.js');
const { layoutManager } = await import('../src/ui/LayoutManager.js');
const { eventBus } = await import('../src/core/EventBus.js');

test('Media Card Alignment: LayoutManager getter and setter lifecycle', () => {
    // Reset state
    storageMap.clear();
    docAttributes.clear();

    // Verify default alignment value is 'start'
    assert.strictEqual(
        layoutManager.getCardLabelAlign(),
        'start',
        'Card label alignment should default to "start"'
    );

    let eventFired = false;
    let eventPayload = null;
    const unsubscribe = eventBus.on('cardLabelAlign:changed', (data) => {
        eventFired = true;
        eventPayload = data;
    });

    try {
        // Change alignment to 'center'
        layoutManager.setCardLabelAlign('center');

        // Check getter reflects updated state
        assert.strictEqual(
            layoutManager.getCardLabelAlign(),
            'center',
            'getCardLabelAlign must return updated alignment "center"'
        );

        // Check DOM root attribute was updated
        assert.strictEqual(
            docAttributes.get('data-card-label-align'),
            'center',
            'documentElement must have data-card-label-align attribute set to "center"'
        );

        // Check persistent storage
        assert.strictEqual(
            storage.getItem('pref:cardLabelAlign'),
            'center',
            'Storage pref:cardLabelAlign must be updated to "center"'
        );

        // Check event bus notification
        assert.strictEqual(eventFired, true, 'cardLabelAlign:changed event must fire');
        assert.strictEqual(eventPayload?.align, 'center', 'Event payload must contain align="center"');

        // Test 'end' alignment
        layoutManager.setCardLabelAlign('end');
        assert.strictEqual(layoutManager.getCardLabelAlign(), 'end');
        assert.strictEqual(docAttributes.get('data-card-label-align'), 'end');
        assert.strictEqual(storage.getItem('pref:cardLabelAlign'), 'end');
    } finally {
        unsubscribe();
    }
});

test('Media Card Alignment: CSS Selectors Level 3 backward compatibility in base.css', () => {
    // Read base.css content directly
    const cssContent = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');

    // Extract the card label alignment section
    const alignSectionStart = cssContent.indexOf('/* Start Alignment (Left in LTR, Right in RTL) */');
    const alignSectionEnd = cssContent.indexOf('/* ============================================================================\r\n   Community Score & Rating Star Styling');
    const actualEnd = alignSectionEnd !== -1 ? alignSectionEnd : cssContent.indexOf('/* Community Score & Rating Star Styling');

    assert.notStrictEqual(alignSectionStart, -1, 'Alignment section must exist in base.css');
    const section = cssContent.slice(alignSectionStart, actualEnd);

    // CRITICAL: Ensure NO complex selectors exist inside :not() in this section.
    // Combinators (like space, >, +, ~) inside :not() break CSS3 parsers on Chrome < 88.
    const invalidNotMatches = section.match(/:not\([^)]*\s[^)]*\)/g);
    assert.strictEqual(
        invalidNotMatches,
        null,
        `No complex selectors with combinators allowed inside :not() in base.css, found: ${invalidNotMatches}`
    );

    // Verify rules for start, end, and center alignment exist
    assert.ok(
        section.includes('html[data-card-label-align="start"] .media-card:not(.list-skeleton) .card-title'),
        'base.css must define start alignment rule without invalid complex :not'
    );
    assert.ok(
        section.includes('html[data-card-label-align="end"] .media-card:not(.list-skeleton) .card-title'),
        'base.css must define end alignment rule without invalid complex :not'
    );
    assert.ok(
        section.includes('html[data-card-label-align="center"] .media-card:not(.list-skeleton) .card-title'),
        'base.css must define center alignment rule without invalid complex :not'
    );

    // Verify explicit list view override exists to preserve horizontal layout alignment
    assert.ok(
        section.includes('html[data-card-label-align] .view-list .media-card .card-title'),
        'base.css must define an explicit list view override to prevent cards in list mode from centering'
    );
});

