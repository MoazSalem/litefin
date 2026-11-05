import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Home Initial Focus Test Suite
 * ============================================================================
 * Validates that users can choose whether the home screen initially focuses
 * the hero carousel (default) or the first card of the first content row,
 * while keeping the hero carousel visible.
 * ============================================================================
 */

test('HomeTab: renders Initial Focus dropdown tied to the hero carousel toggle', () => {
    const source = readFileSync(path.resolve('src/pages/settings/tabs/HomeTab.js'), 'utf8');

    assert.match(source, /home-initial-focus-select/, 'HomeTab must render home-initial-focus-select dropdown');
    assert.match(
        source,
        /storage\.getItem\('pref:homeInitialFocus'\) \|\| 'hero'/,
        'Initial Focus must default to the hero carousel'
    );
    assert.match(
        source,
        /'#home-initial-focus-item'\]/,
        'Initial Focus item must be shown/hidden with the hero carousel toggle'
    );
});

test('SettingsDropdownConfig: maps home-initial-focus-select to pref:homeInitialFocus', () => {
    const source = readFileSync(path.resolve('src/pages/settings/controllers/SettingsDropdownConfig.js'), 'utf8');

    assert.match(
        source,
        /'home-initial-focus-select':\s*\{\s*key:\s*'pref:homeInitialFocus'/,
        'settings map must persist home-initial-focus-select to pref:homeInitialFocus'
    );
});

test('HomePage: default and fallback focus respect pref:homeInitialFocus', () => {
    const source = readFileSync(path.resolve('src/pages/HomePage.js'), 'utf8');

    assert.match(
        source,
        /_shouldFocusHeroByDefault\(\)\s*\{\s*return storage\.getItem\('pref:homeInitialFocus'\) !== 'firstRow';/,
        'Hero must remain the default focus target unless firstRow is selected'
    );

    const occurrences = source.match(/!this\._shouldFocusHeroByDefault\(\) && this\._focusFirstRowCard\(\)/g) || [];
    assert.equal(
        occurrences.length,
        2,
        'Both the initial focus and the modal-close fallback must try the first row before the hero'
    );
});

test('Locales: en-us and en-gb define Initial Focus strings', () => {
    for (const locale of ['en-us', 'en-gb']) {
        const strings = JSON.parse(readFileSync(path.resolve(`src/locales/${locale}.json`), 'utf8'));
        for (const key of ['HomeInitialFocus', 'HomeInitialFocusDescription', 'HomeInitialFocusFirstRow']) {
            assert.ok(strings[key], `${locale}.json must define ${key}`);
        }
    }
});
