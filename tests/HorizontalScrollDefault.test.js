import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Horizontal Scroll Animation Mode Default Test Suite
 * ============================================================================
 * Validates that:
 * 1. PerformanceTab places Smooth ('native') as the first option in the dropdown.
 * 2. PerformanceTab resolves fallback to 'gpu' on Android and 'native' elsewhere.
 * 3. ScrollController resolves fallback to 'gpu' on Android and 'native' elsewhere.
 * 4. VirtualCardRow resolves fallback to 'gpu' on Android and 'native' elsewhere.
 * ============================================================================
 */

test('PerformanceTab: horizontal scroll dropdown has smooth as first option and platform defaults', () => {
    // Read source code of PerformanceTab
    const tabPath = path.resolve('src/pages/settings/tabs/PerformanceTab.js');
    const tabSource = readFileSync(tabPath, 'utf8');

    // Verify 'native' (Smooth) is the first option in the horizontal-scroll-mode-select dropdown
    assert.match(
        tabSource,
        /'horizontal-scroll-mode-select'[\s\S]*?\[[\s\S]*?\{\s*value:\s*'native',\s*label:\s*i18n\.t\('ScrollModeNative'\)/,
        'PerformanceTab must place Smooth (native) as the first option in the horizontal scroll dropdown'
    );

    // Verify fallback resolves to 'gpu' for Android and 'native' for other platforms
    assert.match(
        tabSource,
        /storage\.getItem\('pref:horizontalScrollMode'\)\s*\|\|\s*\(platformInfo\.isAndroid\s*\?\s*'gpu'\s*:\s*'native'\)/,
        'PerformanceTab must default horizontal scroll to gpu on Android and native elsewhere'
    );
});

test('ScrollController: getHorizontalScrollMode defaults to gpu on Android and native elsewhere', () => {
    // Read source code of ScrollController
    const controllerPath = path.resolve('src/ui/ScrollController.js');
    const controllerSource = readFileSync(controllerPath, 'utf8');

    // Verify fallback logic
    assert.match(
        controllerSource,
        /return\s+platformInfo\.isAndroid\s*\?\s*'gpu'\s*:\s*'native'/,
        'ScrollController getHorizontalScrollMode must return gpu for Android and native for other platforms'
    );
});

test('VirtualCardRow: horizontal scroll mode defaults to gpu on Android and native elsewhere', () => {
    // Read source code of VirtualCardRow
    const rowPath = path.resolve('src/components/VirtualCardRow.js');
    const rowSource = readFileSync(rowPath, 'utf8');

    // Verify fallback logic
    assert.match(
        rowSource,
        /storage\.getItem\('pref:horizontalScrollMode'\)\s*\|\|\s*\(platformInfo\.isAndroid\s*\?\s*'gpu'\s*:\s*'native'\)/,
        'VirtualCardRow must default horizontal scroll to gpu on Android and native elsewhere'
    );
});
