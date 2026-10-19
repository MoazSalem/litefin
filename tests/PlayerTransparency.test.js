import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ============================================================================
 * Hardware Overlay Video Playback Transparency Test Suite
 * ============================================================================
 * Samsung Tizen (AVPlay) and LG webOS render hardware-accelerated video on a
 * dedicated video plane positioned physically behind the webview DOM window.
 *
 * For native playback to render without a pitch-black screen, the root HTML
 * element, body, and all structural wrappers must be completely transparent
 * whenever the '.player-active' class is applied during playback.
 *
 * This test suite asserts that theme-level rules (such as Ambient Glow) do not
 * inadvertently paint an opaque background on the <html> node during playback.
 * ============================================================================
 */

test('Hardware Transparency: ambient.css scopes HTML background with :not(.player-active)', () => {
    // Read ambient theme stylesheet directly from source
    const ambientCssPath = path.resolve('src/themes/ambient.css');
    const ambientCss = fs.readFileSync(ambientCssPath, 'utf8');

    // 1. Ensure the root HTML background rule is strictly scoped to non-playback states
    // If html[data-theme-mode="ambient"] does not include :not(.player-active),
    // it overrides html.player-active transparency due to cascade order.
    assert.match(
        ambientCss,
        /html\[data-theme-mode="ambient"\]:not\(\.player-active\)/,
        'ambient.css must scope html[data-theme-mode="ambient"] with :not(.player-active)'
    );

    // 2. Ensure ambient.css explicitly resets html.player-active[data-theme-mode="ambient"] to transparent
    assert.match(
        ambientCss,
        /html\.player-active\[data-theme-mode="ambient"\].*?\{[^}]*background(-color)?:\s*transparent\s*!important;/s,
        'ambient.css must explicitly define transparent background for html.player-active[data-theme-mode="ambient"]'
    );
});

test('Hardware Transparency: base.css defines robust selector for html.player-active across all themes', () => {
    // Read baseline stylesheet from source
    const baseCssPath = path.resolve('src/styles/base.css');
    const baseCss = fs.readFileSync(baseCssPath, 'utf8');

    // Ensure base.css targets html.player-active[data-theme-mode] with transparent !important
    assert.match(
        baseCss,
        /html\.player-active\[data-theme-mode\]/,
        'base.css must define html.player-active[data-theme-mode] selector'
    );

    assert.match(
        baseCss,
        /html\.player-active\[data-theme-mode\].*?background-color:\s*transparent\s*!important;/s,
        'base.css must enforce transparent background-color for active player across all themes'
    );
});

test('Hardware Transparency: index.html critical inline style covers data-theme-mode transparency', () => {
    // Read index.html from source
    const indexHtmlPath = path.resolve('src/index.html');
    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    // Ensure critical inline CSS includes attribute-scoped player-active transparency
    assert.match(
        indexHtml,
        /html\.player-active\[data-theme-mode\]/,
        'index.html inline style must include html.player-active[data-theme-mode]'
    );
});
