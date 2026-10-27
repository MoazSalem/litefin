import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * Sidebar Collapsed Focus Labels Test Suite
 * ============================================================================
 * Verifies that sidebar labels and tooltips in modern collapsed layout,
 * floating buttons, and floating island layouts reliably render when focused
 * via spatial navigation, keyboard, D-pad, or remote control, rather than
 * only displaying upon mouse hover.
 * ============================================================================
 */

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Sidebar CSS: general collapsed text suppression excludes focused elements', () => {
    // Read the main sidebar styles sheet
    const sidebarCss = read('../src/styles/sidebar.css');

    // Verify that the unexpanded, unhovered hiding rule does NOT match focused items
    // It must explicitly check for :not(:focus):not(.focused)
    const generalCollapsedRule = sidebarCss.includes(
        '.sidebar:not(.expanded):not(:hover) .sidebar-item:not(#sidebar-sub-libraries *):not(:focus):not(.focused) .item-text'
    );
    assert.ok(
        generalCollapsedRule,
        'Main sidebar.css must exclude :not(:focus):not(.focused) from item-text display:none suppression'
    );

    // Verify user name and syncplay label rules also preserve focused states
    const userNameExcluded = sidebarCss.includes(
        '.sidebar:not(.expanded):not(:hover) .sidebar-item:not(:focus):not(.focused) .sidebar-user-name'
    );
    const syncplayExcluded = sidebarCss.includes(
        '.sidebar:not(.expanded):not(:hover) .sidebar-item:not(:focus):not(.focused) .sidebar-syncplay-label'
    );
    assert.ok(userNameExcluded, 'sidebar-user-name suppression must exclude focused items');
    assert.ok(syncplayExcluded, 'sidebar-syncplay-label suppression must exclude focused items');

    // Verify ultra-legacy suppression also excludes focused elements
    const ultraLegacyRule = sidebarCss.includes(
        'html[data-layout-tier="ultra-legacy"] .sidebar:not(.expanded):not(:hover) .sidebar-item:not(#sidebar-sub-libraries *):not(:focus):not(.focused) .item-text'
    );
    assert.ok(ultraLegacyRule, 'ultra-legacy tier must exclude :not(:focus):not(.focused)');
});

test('Modern Sidebar CSS: reveals tooltips on both :focus and .focused for modern-collapsed, buttons, and island', () => {
    // Read modern sidebar styles
    const modernSidebarCss = read('../src/styles/modern/sidebar.css');

    // Check layouts under test
    const targetLayouts = ['modern-collapsed', 'floating-buttons', 'floating-island'];

    for (const layout of targetLayouts) {
        // Must reveal .item-text on :focus
        const itemFocus = modernSidebarCss.includes(`html[data-layout-sidebar="${layout}"] .sidebar-item:focus .item-text`);
        assert.ok(itemFocus, `${layout} must have reveal rule for .sidebar-item:focus .item-text`);

        // Must reveal .item-text on .focused (spatial navigation class)
        const itemFocused = modernSidebarCss.includes(`html[data-layout-sidebar="${layout}"] .sidebar-item.focused .item-text`);
        assert.ok(itemFocused, `${layout} must have reveal rule for .sidebar-item.focused .item-text`);

        // Must reveal #sidebar-logo-header tooltip on :focus
        const logoFocus = modernSidebarCss.includes(`html[data-layout-sidebar="${layout}"] #sidebar-logo-header:focus .logo-tooltip`);
        assert.ok(logoFocus, `${layout} must have reveal rule for #sidebar-logo-header:focus .logo-tooltip`);

        // Must reveal #sidebar-logo-header tooltip on .focused
        const logoFocused = modernSidebarCss.includes(`html[data-layout-sidebar="${layout}"] #sidebar-logo-header.focused .logo-tooltip`);
        assert.ok(logoFocused, `${layout} must have reveal rule for #sidebar-logo-header.focused .logo-tooltip`);

        // Must have elevated ID-level specificity anchored at #main-sidebar
        const idAnchorFocus = modernSidebarCss.includes(`html[data-layout-sidebar="${layout}"] #main-sidebar .sidebar-item:focus .item-text`);
        const idAnchorFocused = modernSidebarCss.includes(`html[data-layout-sidebar="${layout}"] #main-sidebar .sidebar-item.focused .item-text`);
        assert.ok(idAnchorFocus, `${layout} must have elevated #main-sidebar ID anchor for :focus`);
        assert.ok(idAnchorFocused, `${layout} must have elevated #main-sidebar ID anchor for .focused`);
    }
});

test('Modern Sidebar CSS: logo action tooltip suppression is safely scoped away from collapsed modes', () => {
    // Read modern sidebar styles
    const modernSidebarCss = read('../src/styles/modern/sidebar.css');

    // Logo tooltip hiding must be scoped to expanded modern or non-collapsed layouts
    // rather than an unqualified global `.logo-tooltip` rule
    const globalUnscoped = modernSidebarCss.match(/^\.logo-tooltip,\s*$/m);
    assert.equal(globalUnscoped, null, 'Unqualified global .logo-tooltip selector must not exist');

    // Collapsed modes must be excluded from logo-tooltip hiding
    assert.ok(
        modernSidebarCss.includes('html:not([data-layout-sidebar="modern-collapsed"]):not([data-layout-sidebar="floating-buttons"]):not([data-layout-sidebar="floating-island"])'),
        'Logo tooltip hiding must explicitly exempt collapsed layout modes'
    );
});
