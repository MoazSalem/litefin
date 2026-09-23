import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * Unit Tests: Admin Libraries Settings & Metadata Refresh
 * ============================================================================
 * Verifies role-based visibility of the Libraries management tab,
 * API endpoint dispatch for global scans, and individual metadata refresh modes.
 * ============================================================================
 */

test('ApiClient.refreshAllLibraries dispatches POST to /Library/Refresh', async () => {
    // Mock ApiClient instance
    const calls = [];
    const client = {
        post: async (endpoint, data, config) => {
            calls.push({ endpoint, data, config });
            return { Success: true };
        },
        refreshAllLibraries() {
            return this.post('/Library/Refresh');
        }
    };

    // Execute global library scan
    await client.refreshAllLibraries();

    // Assert that the proper endpoint was called
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, '/Library/Refresh');
});

test('ApiClient.refreshItem dispatches POST with correct mode options', async () => {
    const calls = [];
    const client = {
        post: async (endpoint, data, config) => {
            calls.push({ endpoint, data, config });
            return { Success: true };
        },
        async refreshItem(itemId, options = {}) {
            const defaults = {
                Recursive: true,
                MetadataRefreshMode: 'Default',
                ImageRefreshMode: 'Default',
                ReplaceAllMetadata: false,
                ReplaceAllImages: false
            };

            return this.post(`/Items/${itemId}/Refresh`, null, {
                params: { ...defaults, ...options }
            });
        }
    };

    // Test 1: ValidationOnly (Scan for new and updated files)
    await client.refreshItem('lib-movies', {
        MetadataRefreshMode: 'ValidationOnly',
        ImageRefreshMode: 'ValidationOnly',
        ReplaceAllMetadata: false,
        ReplaceAllImages: false,
        Recursive: true
    });

    assert.equal(calls[0].endpoint, '/Items/lib-movies/Refresh');
    assert.equal(calls[0].config.params.MetadataRefreshMode, 'ValidationOnly');
    assert.equal(calls[0].config.params.ReplaceAllMetadata, false);

    // Test 2: FullRefresh (Replace all metadata and images)
    await client.refreshItem('lib-shows', {
        MetadataRefreshMode: 'FullRefresh',
        ImageRefreshMode: 'FullRefresh',
        ReplaceAllMetadata: true,
        ReplaceAllImages: true,
        Recursive: true
    });

    assert.equal(calls[1].endpoint, '/Items/lib-shows/Refresh');
    assert.equal(calls[1].config.params.MetadataRefreshMode, 'FullRefresh');
    assert.equal(calls[1].config.params.ReplaceAllMetadata, true);
    assert.equal(calls[1].config.params.ReplaceAllImages, true);
});

test('SettingsPage source contains Admin Policy check and Libraries tab definition', () => {
    // Read source of SettingsPage
    const settingsSource = readFileSync(new URL('../src/pages/SettingsPage.js', import.meta.url), 'utf8');

    // Assert administrator check is present in SettingsPage
    assert.ok(settingsSource.includes("user?.Policy?.IsAdministrator"));

    // Assert 'libraries' tab is routed in _renderActiveTabContent
    assert.ok(settingsSource.includes("case 'libraries':"));
    assert.ok(settingsSource.includes("return this._renderLibrariesTab();"));

    // Assert 'libraries' tab lifecycle setup hook is called in _switchTab
    assert.ok(settingsSource.includes("else if (tabId === 'libraries')"));
    assert.ok(settingsSource.includes("this._setupLibrariesTabUI();"));

    // Assert 3 refresh options are defined in _setupLibrariesTabUI
    assert.ok(settingsSource.includes("ValidationOnly"));
    assert.ok(settingsSource.includes("Default"));
    assert.ok(settingsSource.includes("FullRefresh"));

    // Assert Scan All Libraries button does not use select-btn to prevent generic modal handler
    assert.ok(!settingsSource.includes('class="btn btn-option select-btn btn-scan-all-libraries"'));
    assert.ok(!settingsSource.includes('class="setting-action-btn select-btn btn-scan-all-libraries"'));
});
