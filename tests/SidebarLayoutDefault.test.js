import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Sidebar Layout Mode Default Verification Test Suite
 * ============================================================================
 * Validates that:
 * 1. LayoutManager constructor initializes _sidebarLayout to 'modern-collapsed'.
 * 2. LayoutManager initialization unconditionally defaults defaultSidebarLayout
 *    to 'modern-collapsed' across all platforms and tiers (including legacy
 *    and ultra-legacy hardware), ensuring uniform modern collapsed navigation.
 * 3. Settings SidebarTab renders the sidebar layout dropdown using
 *    'modern-collapsed' as the fallback.
 * ============================================================================
 */

test('LayoutManager: source code defaults sidebar layout to modern-collapsed across all tiers', () => {
    // Read source code of LayoutManager
    const layoutPath = path.resolve('src/ui/LayoutManager.js');
    const layoutSource = readFileSync(layoutPath, 'utf8');

    // Verify constructor assignment defaults to 'modern-collapsed'
    assert.match(
        layoutSource,
        /this\._sidebarLayout\s*=\s*['"]modern-collapsed['"]/,
        'LayoutManager constructor must initialize _sidebarLayout to "modern-collapsed"'
    );

    // Verify defaultSidebarLayout is unconditionally set to 'modern-collapsed'
    // without branching on ultra-legacy or legacy platform tier checks
    assert.match(
        layoutSource,
        /const\s+defaultSidebarLayout\s*=\s*['"]modern-collapsed['"]/,
        'LayoutManager init must default defaultSidebarLayout to "modern-collapsed" unconditionally'
    );

    // Verify that ultra-legacy no longer defaults to 'classic' sidebar
    assert.doesNotMatch(
        layoutSource,
        /defaultSidebarLayout\s*=\s*isUltraLegacy\s*\?\s*['"]classic['"]/,
        'LayoutManager must not branch ultra-legacy to classic sidebar layout by default'
    );

    // Verify savedSidebarLayout uses defaultSidebarLayout as fallback
    assert.match(
        layoutSource,
        /savedSidebarLayout\s*=\s*storage\.getItem\(['"]pref:sidebarLayoutMode['"]\)\s*\|\|\s*defaultSidebarLayout/,
        'LayoutManager init must read pref:sidebarLayoutMode with defaultSidebarLayout fallback'
    );
});

test('SidebarTab: dropdown configuration defaults to modern-collapsed fallback', () => {
    // Read source code of SidebarTab
    const tabPath = path.resolve('src/pages/settings/tabs/SidebarTab.js');
    const tabSource = readFileSync(tabPath, 'utf8');

    // Verify sidebar-layout-select fallback is 'modern-collapsed'
    assert.match(
        tabSource,
        /layoutManager\.getSidebarLayout\(\)\s*\|\|\s*['"]modern-collapsed['"]/,
        'SidebarTab must use "modern-collapsed" fallback for sidebar-layout-select'
    );
});

