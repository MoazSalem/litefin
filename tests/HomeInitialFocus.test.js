import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Home Screen Initial Focus Preference Test Suite
 * ============================================================================
 * Verifies that users can customize the initial focus target on the home screen
 * between the first content row (default) and the featured hero carousel.
 * ============================================================================
 */

test('HomeTab: provides initial focus setting with first-row as default and carousel option', () => {
    // Read the Home tab source code
    const homeTabPath = path.resolve('src/pages/settings/tabs/HomeTab.js');
    const source = readFileSync(homeTabPath, 'utf8');

    // Confirm that the initial focus setting key is read from persistent storage defaulting to first-row
    assert.match(
        source,
        /storage\.getItem\('pref:homeInitialFocus'\)\s*\|\|\s*'first-row'/,
        'HomeTab must retrieve pref:homeInitialFocus with first-row as default'
    );

    // Confirm the dropdown control is declared with options
    assert.match(
        source,
        /'home-initial-focus-select'/,
        'HomeTab must render the home-initial-focus-select dropdown control'
    );

    // Confirm the setting item container has the expected identifier for visibility toggling
    assert.match(
        source,
        /'home-initial-focus-item'/,
        'HomeTab must attach home-initial-focus-item ID to control visibility'
    );

    // Confirm that toggling the hero carousel toggle updates the visibility of the initial focus setting
    assert.match(
        source,
        /#home-initial-focus-item/,
        'HomeTab must include #home-initial-focus-item in the hero toggle visibility list'
    );
});

test('SettingsDropdownConfig: registers home-initial-focus-select dropdown mapping', () => {
    // Read settings dropdown configuration dictionary
    const configPath = path.resolve('src/pages/settings/controllers/SettingsDropdownConfig.js');
    const source = readFileSync(configPath, 'utf8');

    // Confirm registration with key pref:homeInitialFocus, type local, and triggerEvent true
    assert.match(
        source,
        /'home-initial-focus-select':\s*\{\s*key:\s*'pref:homeInitialFocus',\s*type:\s*'local',\s*triggerEvent:\s*true\s*\}/,
        'SettingsDropdownConfig must map home-initial-focus-select to pref:homeInitialFocus'
    );
});

test('SettingsDropdownDispatcher: invalidates home page cache on initial focus change', () => {
    // Read dropdown dispatcher source
    const dispatcherPath = path.resolve('src/pages/settings/controllers/SettingsDropdownDispatcher.js');
    const source = readFileSync(dispatcherPath, 'utf8');

    // Confirm cache eviction for home snapshot
    assert.match(
        source,
        /if\s*\(settingConfig\.key === 'pref:homeInitialFocus'\)\s*\{\s*state\.delete\('home:pageCache'\);\s*\}/,
        'SettingsDropdownDispatcher must invalidate home:pageCache when pref:homeInitialFocus changes'
    );
});

test('HomePage: defaults to first-row initial focus and respects carousel preference', () => {
    // Read HomePage implementation
    const homePath = path.resolve('src/pages/HomePage.js');
    const source = readFileSync(homePath, 'utf8');

    // Confirm initial focus preference check defaults to first-row
    assert.match(
        source,
        /storage\.getItem\('pref:homeInitialFocus'\)\s*\|\|\s*'first-row'/,
        'HomePage must consult pref:homeInitialFocus defaulting to first-row'
    );

    // Confirm branching for first-row vs carousel
    assert.match(
        source,
        /if\s*\(initialFocusPref === 'first-row'\)/,
        'HomePage must support explicit branching for first-row preference'
    );

    // Confirm that _loadHeroCarousel checks shouldFocusHeroByDefault
    assert.match(
        source,
        /const shouldFocusHeroByDefault = initialFocusPref !== 'first-row';/,
        'HomePage._loadHeroCarousel must guard focus stealing when initial focus is first-row'
    );

    // Confirm that _restoreHomepageFocusFallback also checks initial focus preference defaulting to first-row
    assert.match(
        source,
        /_restoreHomepageFocusFallback\(\)\s*\{[\s\S]*?const initialFocusPref = storage\.getItem\('pref:homeInitialFocus'\)\s*\|\|\s*'first-row'/,
        'HomePage._restoreHomepageFocusFallback must respect pref:homeInitialFocus defaulting to first-row'
    );
});
