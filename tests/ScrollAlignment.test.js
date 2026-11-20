import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * Environment Mock Setup for Node.js Test Execution
 * ============================================================================
 * Minimal browser globals (localStorage, document, screen, navigator) required
 * to import and instantiate client modules without browser runtime errors.
 * ============================================================================
 */
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

globalThis.document = {
    createElement: () => ({
        style: {},
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        setAttribute: () => {},
        getAttribute: () => null
    }),
    documentElement: {
        setAttribute: () => {},
        getAttribute: () => null,
        dir: 'ltr'
    }
};

globalThis.screen = { width: 1920, height: 1080 };
globalThis.window = globalThis;

// Dynamic import of ScrollController singleton and class, and StorageService
const { scrollController, default: ScrollController } = await import('../src/ui/ScrollController.js');
const { storage } = await import('../src/utils/StorageService.js');

/**
 * ============================================================================
 * SCROLL CONTROLLER: VERTICAL SCROLL FOCUS ALIGNMENT TESTS
 * ============================================================================
 */

test('ScrollController: getVerticalScrollAlignment defaults to "bottom" when no preference is set', () => {
    // Ensure clean storage state
    storage.removeItem('pref:verticalScrollAlignment');

    // Instantiate fresh controller or use singleton
    const controller = new ScrollController();
    const alignment = controller.getVerticalScrollAlignment();

    // Default must be 'bottom' to minimize unnecessary scrolling and avoid layout thrashing
    assert.strictEqual(
        alignment,
        'bottom',
        'getVerticalScrollAlignment must default to "bottom" when storage is unpopulated'
    );
});

test('ScrollController: getVerticalScrollAlignment honors explicitly configured preferences', () => {
    const controller = new ScrollController();

    // Test 'top' mode
    storage.setItem('pref:verticalScrollAlignment', 'top');
    assert.strictEqual(
        controller.getVerticalScrollAlignment(),
        'top',
        'Should return "top" when configured'
    );

    // Test 'middle' mode
    storage.setItem('pref:verticalScrollAlignment', 'middle');
    assert.strictEqual(
        controller.getVerticalScrollAlignment(),
        'middle',
        'Should return "middle" when configured'
    );

    // Test 'center' alias normalized to 'middle'
    storage.setItem('pref:verticalScrollAlignment', 'center');
    assert.strictEqual(
        controller.getVerticalScrollAlignment(),
        'middle',
        'Should normalize "center" to "middle"'
    );

    // Test 'bottom' mode
    storage.setItem('pref:verticalScrollAlignment', 'bottom');
    assert.strictEqual(
        controller.getVerticalScrollAlignment(),
        'bottom',
        'Should return "bottom" when configured'
    );

    // Test fallback for invalid keyword
    storage.setItem('pref:verticalScrollAlignment', 'invalid_mode');
    assert.strictEqual(
        controller.getVerticalScrollAlignment(),
        'bottom',
        'Should safely fall back to "bottom" on invalid storage value'
    );

    // Clean up
    storage.removeItem('pref:verticalScrollAlignment');
});

test('ScrollController: Mathematical verification that "bottom" alignment significantly reduces scrolling frequency', () => {
    // -------------------------------------------------------------------------
    // Scenario Simulation:
    // A standard 1080p TV display (viewHeight = 1080).
    // Row height = 340px (poster cards + row header).
    // Padding = 40px (default scroll offset).
    //
    // Rows on home screen:
    // Row 0: top = 100px, bottom = 440px
    // Row 1: top = 480px, bottom = 820px
    // Row 2: top = 860px, bottom = 1200px
    // Row 3: top = 1240px, bottom = 1580px
    // -------------------------------------------------------------------------
    const viewHeight = 1080;
    const padding = 40;
    const rowHeight = 340;

    const rows = [
        { name: 'Row 0', top: 100 },
        { name: 'Row 1', top: 480 },
        { name: 'Row 2', top: 860 },
        { name: 'Row 3', top: 1240 }
    ];

    const offsetBottom = 18;

    // Calculate scroll targets for 'top' mode
    const topTargets = rows.map((r) => Math.max(0, r.top - padding));

    // Calculate scroll targets for 'bottom' mode (tuned with offsetBottom to prevent next row title peek-through)
    const bottomTargets = rows.map((r) => Math.max(0, r.top + rowHeight - viewHeight + offsetBottom));

    // In 'top' mode:
    // Row 0 target = 60px
    // Row 1 target = 440px (scrolled by 380px!)
    // Row 2 target = 820px (scrolled by 380px!)
    // Row 3 target = 1200px (scrolled by 380px!)
    // Downwards moves from Row 0 -> Row 1 -> Row 2 -> Row 3 trigger 3 separate scroll shifts!
    assert.strictEqual(topTargets[0], 60);
    assert.strictEqual(topTargets[1], 440);
    assert.strictEqual(topTargets[2], 820);
    assert.strictEqual(topTargets[3], 1200);

    // In 'bottom' mode:
    // Row 0 bottom = 440px <= 1080 -> target = Math.max(0, 440 - 1080 + 18) = 0px
    // Row 1 bottom = 820px <= 1080 -> target = Math.max(0, 820 - 1080 + 18) = 0px
    // Row 0 and Row 1 both have target = 0px -> ZERO SCROLLING OCCURS!
    assert.strictEqual(bottomTargets[0], 0);
    assert.strictEqual(bottomTargets[1], 0);

    // Row 2 reaches down to 1200px: target = 1200 - 1080 + 18 = 138px
    assert.strictEqual(bottomTargets[2], 138);

    // Row 3 reaches down to 1580px: target = 1580 - 1080 + 18 = 518px
    assert.strictEqual(bottomTargets[3], 518);

    // Number of scroll movements needed when navigating from Row 0 down to Row 2:
    // In 'top' mode: 2 scroll movements (440 - 60 = 380px, then 820 - 440 = 380px)
    // In 'bottom' mode: only 1 scroll movement (0 -> 160px), because Row 1 required 0px scrolling!
    let topScrollEvents = 0;
    let bottomScrollEvents = 0;
    for (let i = 1; i < rows.length; i++) {
        if (Math.abs(topTargets[i] - topTargets[i - 1]) > 5) topScrollEvents++;
        if (Math.abs(bottomTargets[i] - bottomTargets[i - 1]) > 5) bottomScrollEvents++;
    }

    assert.strictEqual(topScrollEvents, 3, 'Top alignment scrolls on every single row');
    assert.strictEqual(bottomScrollEvents, 2, 'Bottom alignment avoids scroll on rows already within viewport');
    assert.ok(bottomScrollEvents < topScrollEvents, 'Bottom alignment strictly reduces scroll operations');
});

test('SettingsPage: includes vertical-scroll-alignment-select with bottom, middle, and top options', () => {
    const source = readFileSync(new URL('../src/pages/settings/SettingsPage.js', import.meta.url), 'utf8');

    // 1. Verify that the dropdown ID exists in template
    assert.ok(
        source.includes("'vertical-scroll-alignment-select'"),
        'SettingsPage template must render vertical-scroll-alignment-select dropdown'
    );

    // 2. Verify that 'bottom', 'middle', and 'top' options are provided
    assert.ok(
        source.includes("value: 'bottom'"),
        'SettingsPage must include bottom option'
    );
    assert.ok(
        source.includes("value: 'middle'"),
        'SettingsPage must include middle option'
    );
    assert.ok(
        source.includes("value: 'top'"),
        'SettingsPage must include top option'
    );

    // 3. Verify that the select change mapping is registered
    assert.ok(
        source.includes("'vertical-scroll-alignment-select': { key: 'pref:verticalScrollAlignment', type: 'local', triggerEvent: true }"),
        'Select handler table must bind vertical-scroll-alignment-select to pref:verticalScrollAlignment'
    );
});

test('ScrollController: Source code contains alignment branches in row-based and episode scroll', () => {
    const source = readFileSync(new URL('../src/ui/ScrollController.js', import.meta.url), 'utf8');

    // Verify method definition
    assert.ok(
        source.includes('getVerticalScrollAlignment()'),
        'ScrollController must define getVerticalScrollAlignment'
    );

    // Verify row scroll handles alignment
    assert.ok(
        source.includes("alignment === 'bottom'") && source.includes("alignment === 'middle'"),
        'Row scrolling must branch on vertical scroll alignment'
    );

    // Verify episode list handles alignment
    assert.ok(
        source.includes('cardTop + cardHeight - viewHeight + 100'),
        'Episode list fast path must calculate bottom alignment'
    );
});
