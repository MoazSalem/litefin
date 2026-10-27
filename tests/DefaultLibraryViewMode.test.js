import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Default Library View Mode and Columns Customization Test Suite
 * ============================================================================
 * Validates that users can customize the default library view presentation
 * and items-per-row density without overriding libraries with custom view modes.
 * ============================================================================
 */

test('SettingsPage: contains Default Library View Mode and Items Per Row settings', () => {
    const settingsPath = path.resolve('src/pages/settings/SettingsPage.js');
    const source = readFileSync(settingsPath, 'utf8');

    // Verify view mode dropdown element
    assert.match(
        source,
        /default-library-view-mode-select/,
        'SettingsPage must render default-library-view-mode-select dropdown'
    );

    // Verify columns dropdown element
    assert.match(
        source,
        /default-library-columns-select/,
        'SettingsPage must render default-library-columns-select dropdown'
    );

    // Verify settingsMap registration
    assert.match(
        source,
        /'default-library-view-mode-select':\s*\{\s*key:\s*'pref:defaultLibraryViewMode'/,
        'settingsMap must map default-library-view-mode-select to pref:defaultLibraryViewMode'
    );
    assert.match(
        source,
        /'default-library-columns-select':\s*\{\s*key:\s*'pref:defaultLibraryGridColumns'/,
        'settingsMap must map default-library-columns-select to pref:defaultLibraryGridColumns'
    );

    // Verify cache invalidation when defaults change
    assert.match(
        source,
        /settingConfig\.key === 'pref:defaultLibraryViewMode' \|\|\s*settingConfig\.key === 'pref:defaultLibraryGridColumns'/,
        'SettingsPage must invalidate library caches when default view mode or columns change'
    );
});

test('LibraryPage: respects configured default viewMode and column count without overriding custom modes', () => {
    const libraryPath = path.resolve('src/pages/LibraryPage.js');
    const source = readFileSync(libraryPath, 'utf8');

    // Verify fallback checks user-configured defaultLibraryViewMode
    assert.match(
        source,
        /storage\.getItem\('pref:defaultLibraryViewMode'\)/,
        'LibraryPage must check pref:defaultLibraryViewMode for fallback view mode'
    );

    // Verify libraries with existing custom view modes are preserved (saved is truthy)
    assert.match(
        source,
        /if\s*\(\s*saved\s*\)\s*\{[\s\S]*?this\.state\.viewMode\s*=\s*allowedModes\.includes\(saved\)\s*\?\s*saved/,
        'LibraryPage must keep custom saved view mode when present'
    );

    // Verify _getDefaultColumnsForMode checks mode-specific and generic column preferences
    assert.match(
        source,
        /_getDefaultColumnsForMode\(mode\)\s*\{[\s\S]*?pref:defaultLibraryGridColumns:\$\{mode\}[\s\S]*?pref:defaultLibraryGridColumns/,
        '_getDefaultColumnsForMode must check user column preferences before static fallback'
    );
});

test('LayoutManager: implements default library view mode and column helper methods', () => {
    const layoutPath = path.resolve('src/ui/LayoutManager.js');
    const source = readFileSync(layoutPath, 'utf8');

    assert.match(
        source,
        /getDefaultLibraryViewMode\(\)/,
        'LayoutManager must have getDefaultLibraryViewMode method'
    );
    assert.match(
        source,
        /setDefaultLibraryViewMode\(mode/,
        'LayoutManager must have setDefaultLibraryViewMode method'
    );
    assert.match(
        source,
        /getDefaultLibraryGridColumns\(mode\)/,
        'LayoutManager must have getDefaultLibraryGridColumns method'
    );
    assert.match(
        source,
        /setDefaultLibraryGridColumns\(columns,\s*mode/,
        'LayoutManager must have setDefaultLibraryGridColumns method'
    );
});

