import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * WebOS Stall Recovery Timeout Unit Suite
 * ============================================================================
 * Verifies that the stall recovery timeout is treated as milliseconds,
 * normalizing legacy second values (< 100) while honoring millisecond
 * configuration without order-of-magnitude inflation.
 * ============================================================================
 */

test('WebOSPlayer: stall recovery timeout is evaluated in milliseconds', () => {
    const webosSource = readFileSync(
        new URL('../src/player/core/WebOSPlayer.js', import.meta.url),
        'utf8'
    );
    const settingsSource = readFileSync(
        new URL('../src/utils/PlayerSettings.js', import.meta.url),
        'utf8'
    );
    const settingsPageSource = readFileSync(
        new URL('../src/pages/settings/SettingsPage.js', import.meta.url),
        'utf8'
    );

    // 1. PlayerSettings defaults webosStallRecovery to 8000ms
    assert.match(
        settingsSource,
        /webosStallRecovery:\s*8000,/,
        'PlayerSettings must default webosStallRecovery to 8000 milliseconds'
    );

    // 2. SettingsPage fallback matches 8000ms
    assert.match(
        settingsPageSource,
        /PlayerSettings\.get\('webosStallRecovery'\)\s*\|\|\s*8000/,
        'SettingsPage must fallback to 8000ms'
    );

    // 3. WebOSPlayer normalizes values < 100 and passes recoveryDelayMs to setTimeout
    assert.ok(
        webosSource.includes('rawRecoverySetting < 100 ? rawRecoverySetting * 1000 : rawRecoverySetting'),
        'WebOSPlayer must normalize legacy seconds (< 100) to milliseconds'
    );
    assert.ok(
        webosSource.includes('}, recoveryDelayMs);'),
        'WebOSPlayer must schedule _stallTimer with recoveryDelayMs directly'
    );
});
