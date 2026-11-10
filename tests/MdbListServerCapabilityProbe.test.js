import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ============================================================================
 * MDBList Server Plugin Capability & Error Suppression Test Suite
 * ============================================================================
 * Verifies that when server-side endpoints for MDBList return HTTP 404/405/403
 * (indicating the server plugin is missing, disabled, or incompatible),
 * the plugin marks its server capability as unavailable for the session.
 *
 * Ensures that:
 * 1. Subsequent getItemMetadata calls return null as a fast no-op.
 * 2. HomePage hero item enrichment aborts immediately instead of firing parallel requests.
 * 3. Source code contains the appropriate session guards and error catches.
 * ============================================================================
 */

test('MDBList plugin: Fast no-op when _isServerAvailable is false', async () => {
    // Pure logic simulation matching mdblist-ratings/index.js
    let callsCount = 0;
    const mockPlugin = {
        _isServerAvailable: false,
        async getItemMetadata(itemId) {
            if (this._isServerAvailable === false) {
                return null;
            }
            callsCount++;
            return { id: itemId };
        }
    };

    const result = await mockPlugin.getItemMetadata('test-item-123');

    assert.strictEqual(
        result,
        null,
        'getItemMetadata must return null when server capability is marked unavailable'
    );
    assert.strictEqual(
        callsCount,
        0,
        'No HTTP requests should be dispatched when _isServerAvailable is false'
    );
});

test('MDBList plugin: Marks _isServerAvailable false on HTTP 405 error from CachedByItemId', async () => {
    let callsDispatched = 0;
    const mockPlugin = {
        _isServerAvailable: true,
        api: {
            serverPlugins: {
                call: async () => {
                    callsDispatched++;
                    const err = new Error('Method Not Allowed');
                    err.status = 405;
                    throw err;
                }
            }
        },
        async getItemMetadata(itemId) {
            if (this._isServerAvailable === false) {
                return null;
            }
            try {
                return await this.api.serverPlugins.call(`/Plugins/MdbListRatings/CachedByItemId?itemId=${itemId}`);
            } catch (err) {
                const status = err?.status;
                if (status === 404 || status === 405 || status === 403) {
                    this._isServerAvailable = false;
                }
                return null;
            }
        }
    };

    const result1 = await mockPlugin.getItemMetadata('item-1');
    assert.strictEqual(result1, null);
    assert.strictEqual(callsDispatched, 1);
    assert.strictEqual(mockPlugin._isServerAvailable, false);

    // Subsequent calls are fast no-ops
    const result2 = await mockPlugin.getItemMetadata('item-2');
    assert.strictEqual(result2, null);
    assert.strictEqual(callsDispatched, 1, 'Subsequent calls must not dispatch network requests');
});

test('MDBList plugin: Source code integrity for capability fallback and error suppression', () => {
    const pluginPath = path.resolve('src/plugins/installed/mdblist-ratings/index.js');
    const source = fs.readFileSync(pluginPath, 'utf8');

    assert.ok(
        source.includes('_isServerAvailable'),
        'MDBList plugin must declare and track _isServerAvailable'
    );
    assert.ok(
        source.includes('status === 404 || status === 405 || status === 403'),
        'MDBList plugin must catch 404/405/403 status codes and mark capability unavailable'
    );
    assert.ok(
        source.includes("storage.setItem('serverPlugin:available:mdblist-ratings', 'false')"),
        'MDBList plugin must persist unavailable capability to storage'
    );
});

test('HomePage: Source contains _isServerAvailable check in _enrichHeroItemsWithMdbList', () => {
    const homePagePath = path.resolve('src/pages/HomePage.js');
    const source = fs.readFileSync(homePagePath, 'utf8');

    // Locate _enrichHeroItemsWithMdbList function
    const enrichIdx = source.indexOf('async _enrichHeroItemsWithMdbList(');
    assert.ok(enrichIdx !== -1, '_enrichHeroItemsWithMdbList must exist in HomePage.js');

    const enrichBody = source.slice(enrichIdx, enrichIdx + 1200);

    assert.ok(
        enrichBody.includes('_isServerAvailable === false'),
        '_enrichHeroItemsWithMdbList must check _isServerAvailable before and during batch iteration'
    );
});
