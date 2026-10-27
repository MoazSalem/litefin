import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Scroll Duration and Physics Engine Defaults Test Suite
 * ============================================================================
 * Validates that:
 * 1. Scroll duration preference defaults to 'smooth' across the application.
 * 2. Scroll physics engine preference defaults to 'spring'.
 * 3. PerformanceTab dropdown selections reflect these updated defaults.
 * ============================================================================
 */

test('ScrollController: default duration resolves to smooth', () => {
    // Read source code of ScrollController
    const controllerPath = path.resolve('src/ui/ScrollController.js');
    const controllerSource = readFileSync(controllerPath, 'utf8');

    // Verify pref:scrollSmoothingDuration fallback resolves to 'smooth' in getBaseVerticalDuration
    assert.match(
        controllerSource,
        /storage\.getItem\('pref:scrollSmoothingDuration'\)\s*\|\|\s*'smooth'/,
        'getBaseVerticalDuration must default scroll smoothing duration to "smooth"'
    );
});

test('PerformanceTab: dropdown defaults resolve to smooth duration and spring physics', () => {
    // Read source code of PerformanceTab
    const tabPath = path.resolve('src/pages/settings/tabs/PerformanceTab.js');
    const tabSource = readFileSync(tabPath, 'utf8');

    // Verify scrollSmoothing resolution defaults to 'smooth'
    assert.match(
        tabSource,
        /storage\.getItem\('pref:scrollSmoothingDuration'\)\s*\|\|\s*'smooth'/,
        'PerformanceTab must resolve default scrollSmoothing to "smooth"'
    );

    // Verify scrollPhysics resolution defaults to 'spring'
    assert.match(
        tabSource,
        /storage\.getItem\('pref:scrollPhysics'\)\s*\|\|\s*'spring'/,
        'PerformanceTab must resolve default scrollPhysics to "spring"'
    );
});

test('SpringPhysics: normalizeScrollPhysics defaults unconfigured values to spring', () => {
    // Read source code of SpringPhysics
    const physicsPath = path.resolve('src/ui/SpringPhysics.js');
    const physicsSource = readFileSync(physicsPath, 'utf8');

    // Verify normalizeScrollPhysics return fallback
    assert.match(
        physicsSource,
        /return\s+'spring';/,
        'normalizeScrollPhysics must return "spring" as its unconfigured fallback'
    );
});
