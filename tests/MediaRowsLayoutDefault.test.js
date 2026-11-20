import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Media Rows Layout Default Verification Test Suite
 * ============================================================================
 * Validates that:
 * 1. LayoutManager initial state defaults horizontal media rows to 'modern'.
 * 2. LayoutManager initialization gracefully defaults unconfigured users to 'modern',
 *    while preserving legacy overrides if explicitly configured.
 * 3. Settings LayoutTab renders the media rows layout dropdown using 'modern' fallback.
 * ============================================================================
 */

test('LayoutManager: source code defaults media rows layout to modern', () => {
    // Read source code of LayoutManager
    const layoutPath = path.resolve('src/ui/LayoutManager.js');
    const layoutSource = readFileSync(layoutPath, 'utf8');

    // Verify constructor assignment defaults to 'modern'
    assert.match(
        layoutSource,
        /this\._mediaRowsLayout\s*=\s*['"]modern['"]/,
        'LayoutManager constructor must initialize _mediaRowsLayout to "modern"'
    );

    // Verify init fallback resolves to 'modern' when no saved preference exists
    assert.match(
        layoutSource,
        /savedMediaRowsLayout\s*=\s*legacy\s*===\s*['"]false['"]\s*\|\|\s*legacy\s*===\s*['"]classic['"]\s*\?\s*['"]classic['"]\s*:\s*['"]modern['"]/,
        'LayoutManager init must default to "modern" unless legacy was explicitly classic or false'
    );
});

test('LayoutTab: dropdown configuration defaults to modern fallback', () => {
    // Read source code of LayoutTab
    const tabPath = path.resolve('src/pages/settings/tabs/LayoutTab.js');
    const tabSource = readFileSync(tabPath, 'utf8');

    // Verify media-rows-layout-select fallback is 'modern'
    assert.match(
        tabSource,
        /layoutManager\.getMediaRowsLayout\(\)\s*\|\|\s*['"]modern['"]/,
        'LayoutTab must use "modern" fallback for media-rows-layout-select'
    );
});
