import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ============================================================================
 * Hide Played in Recently Added - Test Suite
 * ============================================================================
 * Verifies that:
 *   1. HomePage accurately resolves whether to hide played media using local
 *      storage preference first, falling back to server UserConfiguration.
 *   2. HomePage sends isPlayed: false to /Items/Latest instead of invalid Filters.
 *   3. HomePage page cache stores hidePlayedInLatest and invalidates on mismatch.
 *   4. HomeTab toggle invalidates home:pageCache and ApiClient ETag cache.
 *   5. HomeTab toggle synchronizes updated configuration to the server host.
 *   6. HomeTab toggle reads active class directly to prevent state desync.
 * ============================================================================
 */

test('HomePage: Source contract verification for hidePlayedInLatest and cache invalidation', () => {
    const homeSource = readFileSync(path.resolve('src/pages/HomePage.js'), 'utf8');

    // 1. Verify resolver helper method definition
    assert.match(
        homeSource,
        /_shouldHidePlayedInLatest\(\)\s*\{/,
        'HomePage must define _shouldHidePlayedInLatest helper method'
    );

    // 2. Verify fallback to server UserConfiguration.HidePlayedInLatest
    assert.match(
        homeSource,
        /user\?\.Configuration\?\.HidePlayedInLatest/,
        'HomePage must fall back to server UserConfiguration.HidePlayedInLatest when storage is unset'
    );

    // 3. Verify parameter passed to api.getLatestItems is isPlayed: false, not Filters: IsUnplayed
    assert.match(
        homeSource,
        /const params = hidePlayedInLatest \? \{ isPlayed: false \} : \{\};/,
        'HomePage must pass { isPlayed: false } when hidePlayedInLatest is enabled'
    );

    // 4. Verify batch latest pre-fetch calls _shouldHidePlayedInLatest
    assert.match(
        homeSource,
        /const hidePlayed = this\._shouldHidePlayedInLatest\(\);/,
        'HomePage batch latest prefetch must call _shouldHidePlayedInLatest'
    );

    // 5. Verify cache invalidation check in _getValidCache
    assert.match(
        homeSource,
        /if \(cache\.hidePlayedInLatest !== undefined && cache\.hidePlayedInLatest !== currentHidePlayed\)/,
        'HomePage _getValidCache must invalidate cache when hidePlayedInLatest setting changes'
    );

    // 6. Verify snapshot in _savePageCache captures hidePlayedInLatest
    assert.match(
        homeSource,
        /hidePlayedInLatest,\s*homeRowLimit,/,
        'HomePage _savePageCache must persist hidePlayedInLatest in pageCache object'
    );
});

test('HomeTab: Source contract verification for cache invalidation and server configuration sync', () => {
    const homeTabSource = readFileSync(path.resolve('src/pages/settings/tabs/HomeTab.js'), 'utf8');

    // 1. Verify toggle initial value falls back to server UserConfiguration
    assert.match(
        homeTabSource,
        /auth\.getCurrentUser\(\)\?\.Configuration\?\.HidePlayedInLatest/,
        'HomeTab render must fall back to server UserConfiguration.HidePlayedInLatest'
    );

    // 2. Verify toggle click handler determines state from element class
    assert.match(
        homeTabSource,
        /const cur = btn\.classList\.contains\('active'\);/,
        'HomeTab bindToggle must evaluate btn.classList.contains("active") for robust toggling'
    );

    // 3. Verify toggle click handler invalidates StateManager home:pageCache
    assert.match(
        homeTabSource,
        /state\.delete\('home:pageCache'\);/,
        'HomeTab toggle must delete home:pageCache from StateManager'
    );

    // 4. Verify toggle click handler flushes ApiClient ETag cache
    assert.match(
        homeTabSource,
        /api\.clearEtagCache\(\);/,
        'HomeTab toggle must call api.clearEtagCache()'
    );

    // 5. Verify toggle click handler updates server user configuration
    assert.match(
        homeTabSource,
        /api\.updateUserConfiguration\(user\.Configuration\)/,
        'HomeTab toggle must call api.updateUserConfiguration to persist setting to server'
    );
});

test('ApiClient: updateUserConfiguration is defined and routes appropriately', () => {
    const apiSource = readFileSync(path.resolve('src/api/ApiClient.js'), 'utf8');

    assert.match(
        apiSource,
        /async updateUserConfiguration\(configuration\)\s*\{/,
        'ApiClient must define updateUserConfiguration method'
    );
    assert.match(
        apiSource,
        /\/Users\/Configuration\?userId=/,
        'ApiClient updateUserConfiguration must support JF12+ canonical endpoint'
    );
});
