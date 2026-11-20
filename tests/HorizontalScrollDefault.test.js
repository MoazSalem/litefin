import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Scroll Animation Mode Default Test Suite
 * ============================================================================
 * Validates that:
 * 1. PerformanceTab places Smooth ('native') as the first option in the dropdown.
 * 2. PerformanceTab resolves horizontal and vertical scroll fallback to 'native' (Smooth)
 *    across all targets without platform-specific divergence.
 * 3. ScrollController resolves vertical and horizontal fallback to 'native' on all platforms.
 * 4. VirtualCardRow resolves horizontal scroll fallback to 'native' on all platforms.
 * ============================================================================
 */

test('PerformanceTab: horizontal scroll dropdown has smooth as first option and platform defaults', () => {
    // Read source code of PerformanceTab for structural inspection
    const tabPath = path.resolve('src/pages/settings/tabs/PerformanceTab.js');
    const tabSource = readFileSync(tabPath, 'utf8');

    // Verify 'native' (Smooth) is the first option in the horizontal-scroll-mode-select dropdown
    assert.match(
        tabSource,
        /'horizontal-scroll-mode-select'[\s\S]*?\[[\s\S]*?\{\s*value:\s*'native',\s*label:\s*i18n\.t\('ScrollModeNative'\)/,
        'PerformanceTab must place Smooth (native) as the first option in the horizontal scroll dropdown'
    );

    // Verify horizontal scroll fallback resolves uniformly to 'native' for all platforms
    assert.match(
        tabSource,
        /storage\.getItem\('pref:horizontalScrollMode'\)\s*\|\|\s*'native'/,
        'PerformanceTab must default horizontal scroll to native on all platforms'
    );

    // Verify vertical scroll fallback resolves uniformly to 'native' for all platforms
    assert.match(
        tabSource,
        /storage\.getItem\('pref:verticalScrollMode'\)\s*\|\|\s*'native'/,
        'PerformanceTab must default vertical scroll to native on all platforms'
    );
});

test('ScrollController: getHorizontalScrollMode and getVerticalScrollMode default to native on all platforms', () => {
    // Read source code of ScrollController for fallback behavior verification
    const controllerPath = path.resolve('src/ui/ScrollController.js');
    const controllerSource = readFileSync(controllerPath, 'utf8');

    // Verify getHorizontalScrollMode fallback resolves to 'native'
    assert.match(
        controllerSource,
        /getHorizontalScrollMode\(\)\s*\{[\s\S]*?return\s+'native';/,
        'ScrollController getHorizontalScrollMode must return native for all platforms'
    );

    // Verify getVerticalScrollMode fallback resolves to 'native'
    assert.match(
        controllerSource,
        /getVerticalScrollMode\(\)\s*\{[\s\S]*?return\s+'native';/,
        'ScrollController getVerticalScrollMode must return native for all platforms'
    );
});

test('VirtualCardRow: horizontal scroll mode defaults to native on all platforms', () => {
    // Read source code of VirtualCardRow
    const rowPath = path.resolve('src/components/VirtualCardRow.js');
    const rowSource = readFileSync(rowPath, 'utf8');

    // Verify fallback logic defaults to 'native'
    assert.match(
        rowSource,
        /storage\.getItem\('pref:horizontalScrollMode'\)\s*\|\|\s*'native'/,
        'VirtualCardRow must default horizontal scroll to native across all platforms'
    );
});
