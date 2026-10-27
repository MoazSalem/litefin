import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * Sidebar Icon Shadows & Back Button Style Unification Test Suite
 * ============================================================================
 * Validates that:
 *   1. Sidebar back button shadow is removed by default for unified style.
 *   2. Unified sidebar icon shadows are available via configuration.
 *   3. LayoutManager manages sidebar icon shadow state and DOM attributes.
 *   4. SettingsPage properly surfaces and handles the new option.
 * ============================================================================
 */

test('Sidebar CSS: back button has no shadow by default, icon shadows rule exists', () => {
    // Read sidebar stylesheet source
    const sidebarCss = readFileSync('./src/styles/sidebar.css', 'utf8');

    // Confirm that the resting state capsule has box-shadow: none by default
    assert.ok(
        sidebarCss.includes('.sidebar-back-btn .back-icon svg {') &&
        sidebarCss.includes('box-shadow: none;'),
        'Back button svg must default to box-shadow: none'
    );

    // Confirm optional icon shadows rule for back button
    assert.ok(
        sidebarCss.includes('html[data-sidebar-icon-shadows="true"] .sidebar-back-btn .back-icon svg') ||
        sidebarCss.includes('.sidebar.has-icon-shadows .sidebar-back-btn .back-icon svg'),
        'Stylesheet must contain selector enabling shadows for back button capsule'
    );

    // Confirm optional drop shadows rule for navigation items, logo, avatar, and chevron
    assert.ok(
        sidebarCss.includes('html[data-sidebar-icon-shadows="true"] .sidebar .item-icon svg'),
        'Stylesheet must contain drop-shadow selector for navigation item icons'
    );
    assert.ok(
        sidebarCss.includes('filter: drop-shadow('),
        'Stylesheet must use drop-shadow filter on sidebar vector icons'
    );
});

test('Theme CSS: Frost and Paper themes remove default shadow and support icon shadows', () => {
    // Read theme stylesheets
    const frostCss = readFileSync('./src/themes/frost.css', 'utf8');
    const paperCss = readFileSync('./src/themes/paper.css', 'utf8');

    // Verify Frost theme default resting state has box-shadow: none
    assert.ok(
        frostCss.includes('html[data-theme-mode="frost"] .sidebar-back-btn .back-icon svg {') &&
        frostCss.includes('box-shadow: none;'),
        'Frost theme must remove default box-shadow from back button'
    );

    // Verify Paper theme default resting state has box-shadow: none
    assert.ok(
        paperCss.includes('html[data-theme-mode="paper"] .sidebar-back-btn .back-icon svg {') &&
        paperCss.includes('box-shadow: none;'),
        'Paper theme must remove default box-shadow from back button'
    );

    // Verify Frost theme supports sidebar icon shadows
    assert.ok(
        frostCss.includes('html[data-theme-mode="frost"][data-sidebar-icon-shadows="true"]'),
        'Frost theme must support data-sidebar-icon-shadows attribute'
    );

    // Verify Paper theme supports sidebar icon shadows
    assert.ok(
        paperCss.includes('html[data-theme-mode="paper"][data-sidebar-icon-shadows="true"]'),
        'Paper theme must support data-sidebar-icon-shadows attribute'
    );
});

test('SettingsPage: sidebar-icon-shadows-select is registered and wired in settingsMap', () => {
    // Read SettingsPage source
    const settingsSource = readFileSync('./src/pages/settings/SettingsPage.js', 'utf8');

    // Confirm dropdown is rendered
    assert.ok(
        settingsSource.includes("'sidebar-icon-shadows-select'"),
        'SettingsPage must render dropdown with id sidebar-icon-shadows-select'
    );

    // Confirm settingsMap entry
    assert.ok(
        settingsSource.includes("'sidebar-icon-shadows-select': { key: 'pref:sidebarIconShadows', type: 'local', triggerEvent: true }"),
        'settingsMap must register sidebar-icon-shadows-select with triggerEvent: true'
    );

    // Confirm LayoutManager invocation in selection handler
    assert.ok(
        settingsSource.includes("layoutManager.setSidebarIconShadows(newValue === 'shadow' || newValue === 'true');"),
        'Selection handler must invoke layoutManager.setSidebarIconShadows'
    );
});

test('LayoutManager: implements getSidebarIconShadows and setSidebarIconShadows', () => {
    // Read LayoutManager source
    const layoutSource = readFileSync('./src/ui/LayoutManager.js', 'utf8');

    // Verify getter implementation
    assert.ok(
        layoutSource.includes('getSidebarIconShadows()'),
        'LayoutManager must define getSidebarIconShadows method'
    );

    // Verify setter implementation
    assert.ok(
        layoutSource.includes('setSidebarIconShadows(enabled, save = true)'),
        'LayoutManager must define setSidebarIconShadows method'
    );

    // Verify DOM attribute update
    assert.ok(
        layoutSource.includes("document.documentElement.setAttribute('data-sidebar-icon-shadows'"),
        'setSidebarIconShadows must set data-sidebar-icon-shadows attribute on documentElement'
    );
});

test('Sidebar component: manages has-icon-shadows class and event listeners', () => {
    // Read Sidebar source
    const sidebarSource = readFileSync('./src/components/Sidebar.js', 'utf8');

    // Confirm class toggle on mount and updates
    assert.ok(
        sidebarSource.includes("this.el.classList.toggle('has-icon-shadows'"),
        'Sidebar must toggle has-icon-shadows class on element'
    );

    // Confirm event subscriptions
    assert.ok(
        sidebarSource.includes("eventBus.on('sidebarIconShadows:changed'"),
        'Sidebar must subscribe to sidebarIconShadows:changed event'
    );

    // Confirm cleanup in unmount
    assert.ok(
        sidebarSource.includes("eventBus.off('sidebarIconShadows:changed'"),
        'Sidebar must unsubscribe from sidebarIconShadows:changed event in onUnmounted'
    );
});
